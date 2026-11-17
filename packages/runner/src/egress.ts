import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// The engine's container sits on an internal network with no way out but the egress proxy. The
// proxy lets each container through to the model, the daemon's job tools and its fork's own
// hosts, and to nothing else, not even a hostname lookup.
export const sandboxNetwork = 'chat-explorer-sandbox';
// One proxy per daemon port, so a second daemon, such as a test one, keeps its own.
export const egressContainer = (port: number) => `chat-explorer-egress-${port}`;
const proxyAddress = (port: number) => `${egressContainer(port)}:3128`;

export const alwaysAllowedHosts = ['api.anthropic.com:443'];
export const toolsHost = (port: number) => `host.docker.internal:${port}`;

// Policies are written by the runner and only read by the proxy; logs are written by the proxy.
export const egressFolders = (egressPath: string) => ({
  policies: join(egressPath, 'policies'),
  logs: join(egressPath, 'logs'),
});

const proxySource = readFileSync(new URL('../proxy/egress-proxy.mjs', import.meta.url), 'utf8');
const proxyScript = `${proxySource}
await startEgressProxy(JSON.parse(process.env.EGRESS_OPTIONS));
`;

const proxyEnvironmentNames = ['HTTPS_PROXY', 'HTTP_PROXY', 'https_proxy', 'http_proxy'];

// What a container of the engine adds to reach the outside only through the proxy. The proxy
// address carries the container's sign-in, so it comes from the environment, not the arguments.
export const sandboxArguments = () => [
  '--network',
  sandboxNetwork,
  ...proxyEnvironmentNames.flatMap((name) => ['--env', name]),
  '--env',
  'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1',
];

// One container's way through the proxy: its sign-in, and the hosts its fork allows.
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
  // Written whole and renamed, so the proxy never reads half a file.
  const allow = (allowed: string[]) => {
    const draft = `${file}.${randomBytes(4).toString('hex')}.tmp`;
    writeFileSync(draft, JSON.stringify({ token, hosts: allowed }), { mode: 0o600 });
    renameSync(draft, file);
  };
  allow(hosts);
  const url = `http://${id}:${token}@${proxyAddress(port)}`;
  return {
    environment: Object.fromEntries(proxyEnvironmentNames.map((name) => [name, url])),
    allow,
    close: () => rmSync(file, { force: true }),
  };
}

function docker(args: string[]) {
  return new Promise<{ code: number | null; output: string }>((resolve) => {
    const child = spawn('docker', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', (chunk: Buffer) => (output += chunk.toString()));
    child.stderr.on('data', (chunk: Buffer) => (output += chunk.toString()));
    child.on('error', (error) => resolve({ code: null, output: error.message }));
    child.on('exit', (code) => resolve({ code, output }));
  });
}

async function required(args: string[], what: string) {
  const result = await docker(args);
  if (result.code !== 0) throw new Error(`Could not ${what}: ${result.output.trim()}`);
}

// Starts the network and a fresh proxy, replacing one left from an earlier run. Passes left from
// that run are removed too, since their containers are gone.
export async function ensureEgress(options: { image: string; port: number; egressPath: string }) {
  const { image, port, egressPath } = options;
  const folders = egressFolders(egressPath);
  rmSync(folders.policies, { recursive: true, force: true });
  mkdirSync(folders.policies, { recursive: true });
  mkdirSync(folders.logs, { recursive: true });
  if ((await docker(['network', 'inspect', sandboxNetwork])).code !== 0) {
    await required(
      ['network', 'create', '--internal', sandboxNetwork],
      'create the sandbox network',
    );
  }
  await docker(['rm', '--force', egressContainer(port)]);
  const proxyOptions = {
    policiesPath: '/egress/policies',
    logsPath: '/egress/logs',
    alwaysAllowed: alwaysAllowedHosts,
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
