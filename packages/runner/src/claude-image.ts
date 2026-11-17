import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

// Pinned by digest, so a rebuild gets the same base unless this line changes.
const baseImage =
  'node:22-slim@sha256:5ec23b7c622b00547753bc6ffd78085dd868a68aeb41c8e0a1418f033e13d96d';
export const imageRepository = 'chat-explorer-claude';
export const versionLabel = 'chat-explorer.claude-code-version';
// Raised whenever the Dockerfile below changes, so an image built from an older one is rebuilt.
export const recipeLabel = 'chat-explorer.image-recipe';
export const imageRecipe = '2';

// The tools a coding fork works with. Installed before Claude Code, so a new Claude Code version
// reuses this layer from the build cache. apt checks the packages against Debian's signing keys;
// the versions follow the base image's release, not pinned one by one.
const codingPackages = [
  'ca-certificates',
  'curl',
  'g++',
  'git',
  'jq',
  'make',
  'openssh-client',
  'procps',
  'python3',
  'python3-venv',
  'unzip',
];

// The image a fork's engine runs in: Claude Code at the version the user has, as an unprivileged
// user, with the tools for coding. The updater is off: the container is thrown away and could not
// reach the download hosts.
export const claudeDockerfile = (version: string) => `FROM ${baseImage}
RUN apt-get update && apt-get install --yes --no-install-recommends ${codingPackages.join(' ')} \
  && rm -rf /var/lib/apt/lists/* && useradd --create-home agent
RUN npm install -g @anthropic-ai/claude-code@${version}
USER agent
WORKDIR /home/agent
ENV DISABLE_AUTOUPDATER=1
LABEL ${versionLabel}="${version}" ${recipeLabel}="${imageRecipe}"
`;

export const imageTag = (version: string) => `${imageRepository}:${version}`;

// A build once hung for hours inside `npm install`, so it gets a limit.
const buildTimeoutMs = 15 * 60_000;

interface DockerOptions {
  stdin?: string;
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
}

function docker(args: string[], { stdin, timeoutMs, env }: DockerOptions = {}) {
  return new Promise<{ code: number | null; output: string }>((resolve) => {
    const child = spawn('docker', args, { stdio: ['pipe', 'pipe', 'pipe'], env });
    let output = '';
    const timer =
      timeoutMs === undefined
        ? undefined
        : setTimeout(() => {
            output += `\nStopped after ${timeoutMs / 60_000} minutes.`;
            child.kill('SIGKILL');
          }, timeoutMs);
    child.stdout.on('data', (chunk: Buffer) => (output += chunk.toString()));
    child.stderr.on('data', (chunk: Buffer) => (output += chunk.toString()));
    child.on('error', (error) => resolve({ code: null, output: error.message }));
    child.on('exit', (code) => {
      clearTimeout(timer);
      resolve({ code, output });
    });
    child.stdin.end(stdin);
  });
}

// Built for this version, from today's Dockerfile.
export async function hasImage(version: string) {
  const format = `{{ index .Config.Labels "${recipeLabel}" }}`;
  const result = await docker(['image', 'inspect', '--format', format, imageTag(version)]);
  return result.code === 0 && result.output.trim() === imageRecipe;
}

// Docker Desktop's credential helper asks macOS for access to the keychain, and a build waited on
// that prompt until its time ran out. The base image is public, so the build gets a Docker config
// of its own without the helper: the base image is pulled anonymously, from the same Docker engine
// and with the same CLI plugins.
export async function isolatedDockerConfig() {
  const directory = await mkdtemp(join(tmpdir(), 'chat-explorer-docker-'));
  const config = { cliPluginsExtraDirs: [join(homedir(), '.docker', 'cli-plugins')] };
  await writeFile(join(directory, 'config.json'), JSON.stringify(config));
  return directory;
}

// The new config has no contexts, so the build is pointed at the engine the current context uses.
async function dockerHost() {
  const result = await docker(['context', 'inspect', '--format', '{{.Endpoints.docker.Host}}']);
  const host = result.output.trim();
  return result.code === 0 && host ? host : null;
}

// Builds from a Dockerfile on stdin, so no build context ships with the package.
export async function buildImage(version: string) {
  const [configDirectory, host] = await Promise.all([isolatedDockerConfig(), dockerHost()]);
  const env = {
    ...process.env,
    DOCKER_CONFIG: configDirectory,
    ...(host ? { DOCKER_HOST: host } : {}),
  };
  const result = await docker(['build', '--tag', imageTag(version), '-'], {
    stdin: claudeDockerfile(version),
    timeoutMs: buildTimeoutMs,
    env,
  }).finally(() => rm(configDirectory, { recursive: true, force: true }));
  if (result.code !== 0) {
    throw new Error(`Could not build the Claude Code image: ${result.output.trim().slice(-2_000)}`);
  }
  return imageTag(version);
}

const versionParts = (version: string) => version.split('.').map(Number);

export function newerVersion(left: string, right: string) {
  const [leftParts, rightParts] = [versionParts(left), versionParts(right)];
  for (let index = 0; index < Math.max(leftParts.length, rightParts.length); index++) {
    const difference = (leftParts[index] ?? 0) - (rightParts[index] ?? 0);
    if (difference !== 0) return difference > 0 ? left : right;
  }
  return left;
}

// The newest image built earlier, to run with while the image of a new version builds.
export async function newestBuiltImage() {
  const result = await docker(['image', 'ls', imageRepository, '--format', '{{.Tag}}']);
  if (result.code !== 0) return null;
  const versions = result.output.split('\n').filter((tag) => /^\d+\.\d+\.\d+$/.test(tag));
  return versions.length === 0 ? null : imageTag(versions.reduce(newerVersion));
}

// The version of Claude Code installed on this machine, which the image follows.
export async function installedClaudeVersion() {
  return new Promise<string | null>((resolve) => {
    const child = spawn('claude', ['--version'], { stdio: ['ignore', 'pipe', 'ignore'] });
    let output = '';
    child.stdout.on('data', (chunk: Buffer) => (output += chunk.toString()));
    child.on('error', () => resolve(null));
    child.on('exit', () => resolve(output.match(/\d+\.\d+\.\d+/)?.[0] ?? null));
  });
}
