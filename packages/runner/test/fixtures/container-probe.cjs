// Runs inside a coding container for the security checklist, and prints what it could reach.
const { execFileSync } = require('node:child_process');
const dns = require('node:dns').promises;
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const path = require('node:path');

const paths = JSON.parse(process.argv.at(-1));
const proxy = new URL(process.env.HTTP_PROXY);
const signIn = `Basic ${Buffer.from(`${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`).toString('base64')}`;
const timeout = 5000;

const tcp = (host, port) =>
  new Promise((resolve) => {
    const socket = net.connect({ host, port, timeout });
    socket.on('connect', () => (socket.destroy(), resolve('connected')));
    socket.on('timeout', () => (socket.destroy(), resolve('timeout')));
    socket.on('error', (error) => resolve(error.code));
  });

const throughProxy = (options, signedIn = true) =>
  new Promise((resolve) => {
    const headers = signedIn ? { 'proxy-authorization': signIn } : {};
    const request = http.request({
      host: proxy.hostname,
      port: proxy.port,
      timeout,
      headers,
      ...options,
    });
    request.on('connect', (response) => (response.socket.destroy(), resolve(response.statusCode)));
    request.on('response', (response) => (response.resume(), resolve(response.statusCode)));
    request.on('timeout', () => (request.destroy(), resolve('timeout')));
    request.on('error', (error) => resolve(error.code));
    request.end();
  });

const lookup = (host) =>
  dns.lookup(host).then(
    () => 'resolved',
    (error) => error.code,
  );

const npmView = () => {
  try {
    return execFileSync('npm', ['view', 'left-pad', 'version'], {
      cwd: '/tmp',
      timeout: 60000,
      stdio: ['ignore', 'pipe', 'ignore'],
    })
      .toString()
      .trim();
  } catch {
    return 'failed';
  }
};

const write = (file) => {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, 'probe');
    return 'written';
  } catch (error) {
    return error.code;
  }
};

(async () => {
  const results = {
    lan: await tcp('192.168.1.1', 80),
    metadata: await tcp('169.254.169.254', 80),
    lanThroughProxy: await throughProxy({ method: 'CONNECT', path: '192.168.1.1:443' }),
    metadataThroughProxy: await throughProxy({ path: 'http://169.254.169.254/latest/meta-data/' }),
    dns: await lookup('example.com'),
    outsideDirect: await tcp('1.1.1.1', 443),
    outsideThroughProxy: await throughProxy({ method: 'CONNECT', path: 'example.com:443' }),
    modelThroughProxy: await throughProxy({ method: 'CONNECT', path: 'api.anthropic.com:443' }),
    modelWithoutSignIn: await throughProxy(
      { method: 'CONNECT', path: 'api.anthropic.com:443' },
      false,
    ),
    allowedHostThroughProxy: await throughProxy({
      method: 'CONNECT',
      path: 'registry.npmjs.org:443',
    }),
    allowedHostOverPlainHttp: await throughProxy({ path: 'http://registry.npmjs.org/left-pad' }),
    npm: npmView(),
    runnerConfigVisible: fs.existsSync(paths.runnerConfig),
    otherWorkspaceVisible: fs.existsSync(paths.otherWorkspace),
    ownWorkspace: write(path.join(paths.ownWorkspace, 'probe.txt')),
    otherSessions: write(path.join(paths.otherSessions, 'probe.jsonl')),
    ownSessions: write('/home/agent/.claude/projects/probe.jsonl'),
  };
  console.log(JSON.stringify(results));
})();
