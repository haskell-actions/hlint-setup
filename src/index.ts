import * as core from '@actions/core'
import * as tc from '@actions/tool-cache'
import * as os from 'os'
import * as path from 'path'
import * as httpClient from '@actions/http-client'

const TAR_ARCHIVE = {ext: 'tar.gz', extract: tc.extractTar};
const ZIP_ARCHIVE = {ext: 'zip', extract: tc.extractZip};

const HTTP_CLIENT = new httpClient.HttpClient('haskell-actions/hlint-setup');

interface PlatformArchiveConfig {
  toolType: {pkgPlatform: string, ext: string},
  archiveType: {ext: string, extract: (archivePath: string, toDir: string) => Promise<string>},
};

// process.platform are (linux, darwin, win32, …)
// hlint releases are (linux, osx, windows, …)
const HLINT_PLATFORM_ARCHIVE_CONFIG: Record<string, PlatformArchiveConfig> = {
  darwin: {toolType: {pkgPlatform: 'osx', ext: ''}, archiveType: TAR_ARCHIVE},
  linux: {toolType: {pkgPlatform: 'linux', ext: ''}, archiveType: TAR_ARCHIVE},
  win32: {toolType: {pkgPlatform: 'windows', ext: 'exe'}, archiveType: ZIP_ARCHIVE},
};

// os.arch() gives x64. The package archs are identified as x86_64.
// At least as of hlint 3.1.6, all platforms are x86_64.
const HLINT_ARCH_CONFIG: Record<string, string> = {
  x64: 'x86_64',
};

interface ToolConfig {
  arch: string,
  name: string,
  exeName: string,
  platform: string,
  version: string,
}

interface ArchiveConfig {
  url: string,
  fileName: string,
  extractionSubdir: string,
  extract: (archivePath: string, toDir: string) => Promise<string>,
}

interface HLintReleaseConfig {
  tool: ToolConfig,
  archive: ArchiveConfig,
};

async function getLatestHlintVersion(githubToken: string): Promise<string> {
  const headers: { [key: string]: string } = {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
  };
  if (githubToken) {
    headers['Authorization'] = `Bearer ${githubToken}`;
  }
  const response = await HTTP_CLIENT.getJson(
    'https://api.github.com/repos/ndmitchell/hlint/releases/latest',
    headers);
  return (response.result as { tag_name: string }).tag_name.replace(/^v/, '');
}

async function mkHlintReleaseConfig(nodeOsPlatform: string, nodeArch: string, requestedVersion: string, githubToken: string): Promise<HLintReleaseConfig> {
  const config = HLINT_PLATFORM_ARCHIVE_CONFIG[nodeOsPlatform];
  if (!config) {
    throw Error(`Invalid platform for hlint: ${nodeOsPlatform}`);
  }
  const pkgArch = HLINT_ARCH_CONFIG[nodeArch];
  if (!pkgArch) {
    throw Error(`Unsupported architecture hlint: ${nodeArch}`);
  }

  const {toolType: {pkgPlatform, ext: exeExt}, archiveType: {ext: archiveExt, extract}} = config;

  let hlintVersion = requestedVersion;
  if (hlintVersion === HLINT_DEFAULT_VERSION) {
    hlintVersion = await getLatestHlintVersion(githubToken);
  }

  const toolName = 'hlint';
  const releaseName = `${toolName}-${hlintVersion}`;
  const archiveName = `${releaseName}-${pkgArch}-${pkgPlatform}.${archiveExt}`;
  return {
    tool: {
      arch: nodeArch,
      name: toolName,
      exeName: exeExt ? `${toolName}.${exeExt}` : toolName,
      platform: nodeOsPlatform,
      version: hlintVersion,
    },
    archive: {
      // URL for downloading the archive
      url: `https://github.com/ndmitchell/hlint/releases/download/v${hlintVersion}/${archiveName}`,
      // Filename of the archive
      fileName: archiveName,
      // Subdirectory contents will extract under
      extractionSubdir: releaseName,
      // Function of (archiveFile, extractTo).
      // Archive files will be in `${extractTo}/${extractionSubdir}`.
      extract,
    },
  };
}

async function getHlintExistingPath(hlintReleaseConfig: HLintReleaseConfig): Promise<string> {
  const {tool} = hlintReleaseConfig;
  return tc.find(tool.name, tool.version, tool.arch);
}

async function downloadHlint(hlintReleaseConfig: HLintReleaseConfig): Promise<string> {
  const {tool, archive} = hlintReleaseConfig;
  const {extract: extractArchive, extractionSubdir} = archive;
  const archivePath = await tc.downloadTool(archive.url);
  const extractedFolder = await extractArchive(archivePath, os.homedir());
  const releaseFolder = path.join(extractedFolder, extractionSubdir);
  const cachedDir = await tc.cacheDir(releaseFolder, tool.name, tool.version, tool.arch);
  return cachedDir;
}

async function findOrDownloadHlint(hlintReleaseConfig: HLintReleaseConfig): Promise<string> {
  const existingHlintDir = await getHlintExistingPath(hlintReleaseConfig);
  if (existingHlintDir) {
    core.debug(`Found cached hlint at ${existingHlintDir}`);
    return existingHlintDir;
  } else {
    core.debug('hlint not cached, so attempting to download');
    return core.group('Downloading hlint', async () => await downloadHlint(hlintReleaseConfig));
  }
}

const HLINT_DEFAULT_VERSION = 'latest';

const INPUT_KEY_HLINT_VERSION = 'version';
const INPUT_KEY_GITHUB_TOKEN = 'token';
const OUTPUT_KEY_HLINT_DIR = 'hlint-dir';
const OUTPUT_KEY_HLINT_PATH = 'hlint-bin';
const OUTPUT_KEY_HLINT_VERSION = 'version';

async function run() {
  try {
    const hlintVersion = core.getInput(INPUT_KEY_HLINT_VERSION) || HLINT_DEFAULT_VERSION;
    const githubToken = core.getInput(INPUT_KEY_GITHUB_TOKEN);
    const config = await mkHlintReleaseConfig(process.platform, os.arch(), hlintVersion, githubToken);
    const hlintDir = await findOrDownloadHlint(config);
    core.addPath(hlintDir);
    core.info(`hlint ${config.tool.version} is now set up at ${hlintDir}`);
    core.setOutput(OUTPUT_KEY_HLINT_DIR, hlintDir);
    core.setOutput(OUTPUT_KEY_HLINT_PATH, path.join(hlintDir, config.tool.exeName));
    core.setOutput(OUTPUT_KEY_HLINT_VERSION, config.tool.version);
  } catch (error) {
    core.setFailed(error instanceof Error ? error : String(error));
  }
}

run();
