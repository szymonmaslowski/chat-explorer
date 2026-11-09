import { spawn } from 'node:child_process';

// Pinned by digest, so a rebuild gets the same base unless this line changes.
const baseImage =
  'node:22-slim@sha256:5ec23b7c622b00547753bc6ffd78085dd868a68aeb41c8e0a1418f033e13d96d';
export const imageRepository = 'chat-explorer-claude';
export const versionLabel = 'chat-explorer.claude-code-version';

// The image a fork's engine runs in: Claude Code at the version the user has, as an unprivileged
// user. The updater is off: the container is thrown away and could not reach the download hosts.
export const claudeDockerfile = (version: string) => `FROM ${baseImage}
RUN npm install -g @anthropic-ai/claude-code@${version} && useradd --create-home agent
USER agent
WORKDIR /home/agent
ENV DISABLE_AUTOUPDATER=1
LABEL ${versionLabel}="${version}"
`;

export const imageTag = (version: string) => `${imageRepository}:${version}`;

function docker(args: string[], stdin?: string) {
  return new Promise<{ code: number | null; output: string }>((resolve) => {
    const child = spawn('docker', args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', (chunk: Buffer) => (output += chunk.toString()));
    child.stderr.on('data', (chunk: Buffer) => (output += chunk.toString()));
    child.on('error', (error) => resolve({ code: null, output: error.message }));
    child.on('exit', (code) => resolve({ code, output }));
    child.stdin.end(stdin);
  });
}

export async function hasImage(version: string) {
  return (await docker(['image', 'inspect', imageTag(version)])).code === 0;
}

// Builds from a Dockerfile on stdin, so no build context ships with the package.
export async function buildImage(version: string) {
  const result = await docker(
    ['build', '--tag', imageTag(version), '-'],
    claudeDockerfile(version),
  );
  if (result.code !== 0) {
    throw new Error(`Could not build the Claude Code image: ${result.output.trim().slice(-2_000)}`);
  }
  return imageTag(version);
}

export async function ensureImage(version: string) {
  return (await hasImage(version)) ? imageTag(version) : buildImage(version);
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
