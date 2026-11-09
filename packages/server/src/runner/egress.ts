import { spawn } from 'node:child_process';

// The engine's container sits on an internal network with no way out but this proxy, which lets
// through only the hosts on its list: the model's API over CONNECT, the daemon's job tools over
// plain HTTP. Anything else, even a hostname lookup, fails.
export const sandboxNetwork = 'chat-explorer-sandbox';
export const egressContainer = 'chat-explorer-egress';
export const proxyUrl = `http://${egressContainer}:3128`;

export const allowedHosts = (port: number) => [
  'api.anthropic.com:443',
  `host.docker.internal:${port}`,
];

// A small forward proxy, run with `node -e`, so nothing needs to be mounted into its container.
export const proxyScript = `
const http = require('node:http');
const net = require('node:net');
const allowed = new Set((process.env.ALLOWED || '').split(',').filter(Boolean));
const server = http.createServer((request, response) => {
  let target;
  try { target = new URL(request.url); } catch { response.writeHead(400).end(); return; }
  const port = target.port || '80';
  if (!allowed.has(target.hostname + ':' + port)) { response.writeHead(403).end('Blocked by the sandbox'); return; }
  const upstream = http.request(
    { host: target.hostname, port, method: request.method, path: target.pathname + target.search, headers: request.headers },
    (reply) => { response.writeHead(reply.statusCode || 502, reply.headers); reply.pipe(response); },
  );
  upstream.on('error', () => response.writeHead(502).end());
  request.pipe(upstream);
});
server.on('connect', (request, socket, head) => {
  if (!allowed.has(request.url)) { socket.end('HTTP/1.1 403 Forbidden\\r\\n\\r\\n'); return; }
  const [host, port] = request.url.split(':');
  const upstream = net.connect(Number(port), host, () => {
    socket.write('HTTP/1.1 200 Connection Established\\r\\n\\r\\n');
    upstream.write(head);
    upstream.pipe(socket);
    socket.pipe(upstream);
  });
  upstream.on('error', () => socket.end());
  socket.on('error', () => upstream.destroy());
});
server.listen(3128);
`;

// What a container of the engine adds to reach the outside only through the proxy.
export const sandboxArguments = [
  '--network',
  sandboxNetwork,
  '--env',
  `HTTPS_PROXY=${proxyUrl}`,
  '--env',
  `HTTP_PROXY=${proxyUrl}`,
  '--env',
  'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1',
];

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

// Starts the network and a fresh proxy with today's list, replacing one left from an earlier run.
export async function ensureEgress(image: string, port: number) {
  if ((await docker(['network', 'inspect', sandboxNetwork])).code !== 0) {
    await required(
      ['network', 'create', '--internal', sandboxNetwork],
      'create the sandbox network',
    );
  }
  await docker(['rm', '--force', egressContainer]);
  await required(
    [
      'run',
      '--detach',
      '--name',
      egressContainer,
      '--restart',
      'unless-stopped',
      '--cap-drop',
      'ALL',
      '--security-opt',
      'no-new-privileges',
      '--network',
      'bridge',
      '--env',
      `ALLOWED=${allowedHosts(port).join(',')}`,
      image,
      'node',
      '-e',
      proxyScript,
    ],
    'start the egress proxy',
  );
  await required(
    ['network', 'connect', sandboxNetwork, egressContainer],
    'connect the egress proxy',
  );
}
