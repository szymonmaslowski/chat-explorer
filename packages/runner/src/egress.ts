import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runtime } from './container-runtime.js';

// The engine's container sits on an internal network with no way out but the egress proxy. The
// proxy lets each container through to the daemon's job tools and its fork's own hosts, and to
// nothing else, not even a hostname lookup. It also stands in for the model's API, so the real
// model token stays with the proxy and the container holds a dummy that works only for it.
export const sandboxNetwork = 'chat-explorer-sandbox';
// One proxy per daemon port, so a second daemon, such as a test one, keeps its own.
export const egressContainer = (port: number) => `chat-explorer-egress-${port}`;
const proxyAddress = (port: number) => `${egressContainer(port)}:3128`;
const modelAddress = (port: number) => `${egressContainer(port)}:3129`;

export const toolsHost = (port: number) => `host.docker.internal:${port}`;

// Policies and secrets are written by the runner and only read by the proxy; logs are written by
// the proxy.
export const egressFolders = (egressPath: string) => ({
  policies: join(egressPath, 'policies'),
  secrets: join(egressPath, 'secrets'),
  logs: join(egressPath, 'logs'),
});

// Written whole and renamed, so the proxy never reads half a file.
function writeWhole(file: string, text: string) {
  const draft = `${file}.${randomBytes(4).toString('hex')}.tmp`;
  writeFileSync(draft, text, { mode: 0o600 });
  renameSync(draft, file);
}

// The real model token, for the proxy to put on the engines' requests. Read again for each
// container, so a token the user replaces applies from the next one.
export function writeModelToken(egressPath: string, token: string) {
  const { secrets } = egressFolders(egressPath);
  mkdirSync(secrets, { recursive: true });
  writeWhole(join(secrets, 'model-token'), token);
}

const proxySource = readFileSync(new URL('../proxy/egress-proxy.mjs', import.meta.url), 'utf8');
const proxyScript = `${proxySource}
await startEgressProxy(JSON.parse(process.env.EGRESS_OPTIONS));
`;

const proxyEnvironmentNames = ['HTTPS_PROXY', 'HTTP_PROXY', 'https_proxy', 'http_proxy'];
const passEnvironmentNames = [
  ...proxyEnvironmentNames,
  'NO_PROXY',
  'no_proxy',
  'ANTHROPIC_BASE_URL',
  'CLAUDE_CODE_OAUTH_TOKEN',
];

// What a container of the engine adds to reach the outside only through the proxy. The values
// carry the container's sign-in, so they come from the environment, not the arguments.
export const sandboxArguments = () => [
  '--network',
  sandboxNetwork,
  ...passEnvironmentNames.flatMap((name) => ['--env', name]),
  '--env',
  'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1',
];

// One container's way through the proxy: its sign-in, its dummy model token, and the hosts its
// fork allows.
export interface EgressPass {
  environment: Record<string, string>;
  allow(hosts: string[]): void;
  close(): void;
}

export function openEgressPass(
  egressPath: string,
  port: number,
  id: string,
  hosts: string[],
): EgressPass {
  const { policies } = egressFolders(egressPath);
  mkdirSync(policies, { recursive: true });
  const token = randomBytes(24).toString('hex');
  const file = join(policies, `${id}.json`);
  const allow = (allowed: string[]) => writeWhole(file, JSON.stringify({ token, hosts: allowed }));
  allow(hosts);
  const url = `http://${id}:${token}@${proxyAddress(port)}`;
  return {
    environment: {
      ...Object.fromEntries(proxyEnvironmentNames.map((name) => [name, url])),
      // The model is reached on the proxy's own port, directly, not through the forward proxy.
      NO_PROXY: egressContainer(port),
      no_proxy: egressContainer(port),
      ANTHROPIC_BASE_URL: `http://${modelAddress(port)}`,
      CLAUDE_CODE_OAUTH_TOKEN: `sk-ant-oat01-${id}.${token}`,
    },
    allow,
    close: () => rmSync(file, { force: true }),
  };
}

async function required(args: string[], what: string) {
  const result = await runtime.command(args);
  if (result.code !== 0) throw new Error(`Could not ${what}: ${result.output.trim()}`);
}

// Starts the network and a fresh proxy, replacing one left from an earlier run. Passes left from
// that run are removed too, since their containers are gone.
export async function ensureEgress(options: { image: string; port: number; egressPath: string }) {
  const { image, port, egressPath } = options;
  const folders = egressFolders(egressPath);
  rmSync(folders.policies, { recursive: true, force: true });
  mkdirSync(folders.policies, { recursive: true });
  mkdirSync(folders.secrets, { recursive: true });
  mkdirSync(folders.logs, { recursive: true });
  if ((await runtime.command(['network', 'inspect', sandboxNetwork])).code !== 0) {
    await required(
      ['network', 'create', '--internal', sandboxNetwork],
      'create the sandbox network',
    );
  }
  await runtime.command(['rm', '--force', egressContainer(port)]);
  const proxyOptions = {
    policiesPath: '/egress/policies',
    secretsPath: '/egress/secrets',
    logsPath: '/egress/logs',
    toolsHost: toolsHost(port),
  };
  await required(
    [
      'run',
      '--detach',
      '--name',
      egressContainer(port),
      '--restart',
      'unless-stopped',
      '--cap-drop',
      'ALL',
      '--security-opt',
      'no-new-privileges',
      '--network',
      'bridge',
      '--volume',
      `${folders.policies}:/egress/policies:ro`,
      '--volume',
      `${folders.secrets}:/egress/secrets:ro`,
      '--volume',
      `${folders.logs}:/egress/logs`,
      '--env',
      `EGRESS_OPTIONS=${JSON.stringify(proxyOptions)}`,
      image,
      'node',
      '--input-type=module',
      '-e',
      proxyScript,
    ],
    'start the egress proxy',
  );
  await required(
    ['network', 'connect', sandboxNetwork, egressContainer(port)],
    'connect the egress proxy',
  );
}
