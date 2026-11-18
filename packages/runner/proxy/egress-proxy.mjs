// The engines' only way out. It runs in its own container with `node -e`, so it may import only
// Node's own modules. Each engine container signs in with its fork's id and a token as proxy
// credentials. The runner writes `<policies>/<id>.json` with that token and the fork's hosts when
// the container starts, rewrites it when the hosts change, and removes it when the container ends.
// The policy also names hosts the runner's config allows on your own network, and hidden hosts,
// which the logs never name.
//
// It also stands in for the model's API on a port of its own. The engine holds a dummy token made
// of the same id and token, and the proxy swaps in the real one, which never enters a container.
import { createHash, timingSafeEqual } from 'node:crypto';
import { appendFile, readFile } from 'node:fs/promises';
import { lookup as dnsLookup } from 'node:dns/promises';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { join } from 'node:path';

const policyIdPattern = /^[a-z0-9_-]{1,64}$/;

// Addresses a container must never reach through the proxy: this machine, the local network, the
// cloud metadata service and ranges that are not on the public internet.
const privateRanges = new net.BlockList();
for (const [address, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
]) {
  privateRanges.addSubnet(address, prefix, 'ipv4');
}
for (const [address, prefix] of [
  ['::', 127],
  ['64:ff9b::', 96],
  ['64:ff9b:1::', 48],
  ['100::', 64],
  ['2001::', 32],
  ['2001:db8::', 32],
  ['2002::', 16],
  ['fc00::', 7],
  ['fe80::', 10],
  ['ff00::', 8],
]) {
  privateRanges.addSubnet(address, prefix, 'ipv6');
}

const mappedIpv4 = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i;

export function isPublicAddress(address) {
  const family = net.isIP(address);
  if (family === 4) return !privateRanges.check(address, 'ipv4');
  if (family !== 6) return false;
  const mapped = mappedIpv4.exec(address);
  if (mapped) return isPublicAddress(mapped[1]);
  // The hexadecimal spelling of a mapped address, such as ::ffff:c0a8:101.
  if (/^::ffff:[0-9a-f]{1,4}:[0-9a-f]{1,4}$/i.test(address)) return false;
  return !privateRanges.check(address, 'ipv6');
}

const sameToken = (given, expected) => {
  const digest = (text) => createHash('sha256').update(text).digest();
  return timingSafeEqual(digest(given), digest(expected));
};

function credentials(request) {
  const header = request.headers['proxy-authorization'] ?? '';
  const match = /^Basic\s+(\S+)$/i.exec(header);
  if (!match) return null;
  const decoded = Buffer.from(match[1], 'base64').toString();
  const colon = decoded.indexOf(':');
  if (colon < 0) return null;
  return {
    id: decodeURIComponent(decoded.slice(0, colon)),
    token: decodeURIComponent(decoded.slice(colon + 1)),
  };
}

// The model's dummy token: sk-ant-oat01-<id>.<token>, so Claude Code takes it for an OAuth token.
function modelCredentials(request) {
  const match = /^Bearer sk-ant-oat01-([a-z0-9_-]{1,64})\.([0-9a-f]{16,})$/.exec(
    request.headers.authorization ?? '',
  );
  return match ? { id: match[1], token: match[2] } : null;
}

// Headers that describe this hop or carry a credential: never passed to the model's API as sent.
const droppedModelHeaders = new Set([
  'authorization',
  'x-api-key',
  'cookie',
  'host',
  'connection',
  'keep-alive',
  'proxy-authorization',
  'proxy-connection',
  'transfer-encoding',
  'upgrade',
  'te',
  'trailer',
]);

const plainAddress = (address = '') => address.replace(/^::ffff:/, '');

const splitHostPort = (target) => {
  const match = /^([a-z0-9.-]+):(\d{1,5})$/i.exec(target);
  return match ? { host: match[1].toLowerCase(), port: Number(match[2]) } : null;
};

export function startEgressProxy(options) {
  const {
    port = 3128,
    policiesPath,
    logsPath,
    alwaysAllowed = [],
    // Reached by name, never checked for a private address: the daemon on the user's machine.
    toolsHost,
    lookup = (host) => dnsLookup(host, { all: true, verbatim: true }),
    maxConnections = 128,
    connect = (port, host, onConnect) => net.connect(port, host, onConnect),
    modelPort = 3129,
    // Holds `model-token`, the real token, written by the runner.
    secretsPath,
    requestModel = (requestOptions, onResponse) =>
      https.request({ host: 'api.anthropic.com', port: 443, ...requestOptions }, onResponse),
  } = options;
  const open = new Map();
  // Where each pass was first used from. A pass works from that address only, so a token that
  // leaks out of its container is worthless anywhere else.
  const firstSeenAt = new Map();

  const log = (id, line) => {
    const file = policyIdPattern.test(id ?? '') ? `${id}.log` : '_unknown.log';
    appendFile(join(logsPath, file), `${new Date().toISOString()} ${line}\n`).catch(() => {});
  };

  async function signedIn(request, given = credentials(request)) {
    if (!given || !policyIdPattern.test(given.id)) return null;
    let policy;
    try {
      policy = JSON.parse(await readFile(join(policiesPath, `${given.id}.json`), 'utf8'));
    } catch {
      for (const pass of firstSeenAt.keys()) {
        if (pass.startsWith(`${given.id}:`)) firstSeenAt.delete(pass);
      }
      return null;
    }
    if (typeof policy.token !== 'string' || !sameToken(given.token, policy.token)) return null;
    const pass = `${given.id}:${policy.token}`;
    const from = plainAddress(request.socket.remoteAddress);
    if (!firstSeenAt.has(pass)) firstSeenAt.set(pass, from);
    if (firstSeenAt.get(pass) !== from) {
      log(given.id, `denied a request from ${from}: this pass belongs to another container`);
      return null;
    }
    const list = (name) => (Array.isArray(policy[name]) ? policy[name] : []);
    return {
      id: given.id,
      allowed: new Set([...alwaysAllowed, toolsHost, ...list('hosts')]),
      onPrivateNetwork: new Set(list('privateHosts')),
      hidden: new Set(list('hiddenHosts')),
    };
  }

  // Where to connect for an allowed host: the address its name resolves to, checked first, so a
  // name that points at the local network, now or after a quick DNS change, is refused.
  async function address(target, privateAllowed) {
    if (`${target.host}:${target.port}` === toolsHost) return { host: target.host };
    let resolved;
    try {
      resolved = await lookup(target.host);
    } catch {
      return { refused: 'its name does not resolve' };
    }
    if (resolved.length === 0) return { refused: 'its name does not resolve' };
    if (!privateAllowed && resolved.some((entry) => !isPublicAddress(entry.address))) {
      return { refused: 'it resolves to a private address' };
    }
    const chosen = resolved.find((entry) => entry.family === 4) ?? resolved[0];
    return { host: chosen.address };
  }

  const server = http.createServer(async (request, response) => {
    const fork = await signedIn(request);
    if (!fork) {
      // Without a sign-in there is no policy to tell a hidden host by, so no target is logged.
      log(null, `denied a ${request.method} request: no valid proxy sign-in`);
      response.writeHead(407, { 'proxy-authenticate': 'Basic realm="chat-explorer"' }).end();
      return;
    }
    let url;
    try {
      url = new URL(request.url);
    } catch {
      response.writeHead(400).end();
      return;
    }
    const target = `${url.hostname}:${url.port || '80'}`;
    if (url.protocol !== 'http:' || target !== toolsHost) {
      log(
        fork.id,
        `denied plain HTTP to ${fork.hidden.has(target) ? 'a hidden host' : target}: only HTTPS goes out`,
      );
      response.writeHead(403).end('Plain HTTP is refused by the sandbox. Use HTTPS.');
      return;
    }
    const headers = { ...request.headers };
    delete headers['proxy-authorization'];
    const upstream = http.request(
      {
        host: url.hostname,
        port: url.port || 80,
        method: request.method,
        path: url.pathname + url.search,
        headers,
      },
      (reply) => {
        response.writeHead(reply.statusCode ?? 502, reply.headers);
        reply.pipe(response);
      },
    );
    upstream.on('error', () => response.writeHead(502).end());
    request.pipe(upstream);
  });

  server.on('connect', async (request, socket, head) => {
    socket.on('error', () => {});
    const refuse = (status, reason) => socket.end(`HTTP/1.1 ${status}\r\n\r\n${reason}`);
    const fork = await signedIn(request);
    if (!fork) {
      log(null, 'denied a CONNECT: no valid proxy sign-in');
      // A client that first tries without a sign-in retries on a new connection, as this one ends.
      socket.end(
        'HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm="chat-explorer"\r\nConnection: close\r\nContent-Length: 0\r\n\r\n',
      );
      return;
    }
    const target = splitHostPort(request.url);
    const named = target ? `${target.host}:${target.port}` : request.url;
    const shown = fork.hidden.has(named) ? 'a hidden host' : named;
    if (!target || !fork.allowed.has(named)) {
      log(fork.id, `denied ${shown}: not on this fork's list`);
      refuse('403 Forbidden', "Blocked by the sandbox: add the host to this fork's allowed hosts.");
      return;
    }
    const connections = open.get(fork.id) ?? 0;
    if (connections >= maxConnections) {
      log(fork.id, `denied ${shown}: over ${maxConnections} open connections`);
      refuse('429 Too Many Requests', 'Too many open connections.');
      return;
    }
    const where = await address(target, fork.onPrivateNetwork.has(named));
    if (where.refused) {
      log(fork.id, `denied ${shown}: ${where.refused}`);
      refuse('403 Forbidden', `Blocked by the sandbox: ${where.refused}.`);
      return;
    }
    open.set(fork.id, connections + 1);
    let closed = false;
    const release = () => {
      if (closed) return;
      closed = true;
      open.set(fork.id, (open.get(fork.id) ?? 1) - 1);
    };
    const upstream = connect(target.port, where.host, () => {
      log(
        fork.id,
        fork.hidden.has(named) ? `allowed ${shown}` : `allowed ${named} (${where.host})`,
      );
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      upstream.write(head);
      upstream.pipe(socket);
      socket.pipe(upstream);
    });
    upstream.on('error', (error) => {
      log(fork.id, `failed ${shown}: ${error.code ?? error.message}`);
      refuse('502 Bad Gateway', 'Could not connect.');
    });
    upstream.on('close', release);
    socket.on('close', () => {
      release();
      upstream.destroy();
    });
  });

  const modelServer = http.createServer(async (request, response) => {
    const fork = await signedIn(request, modelCredentials(request));
    if (!fork) {
      log(null, `denied model ${request.method} ${request.url}: no valid model token`);
      response.writeHead(401).end();
      return;
    }
    if (!request.url.startsWith('/v1/')) {
      log(fork.id, `denied model ${request.method} ${request.url}: not a model API path`);
      response.writeHead(404).end();
      return;
    }
    let token;
    try {
      token = (await readFile(join(secretsPath, 'model-token'), 'utf8')).replace(/\s+/g, '');
    } catch {
      response.writeHead(503).end('The runner has no model token.');
      return;
    }
    const headers = Object.fromEntries(
      Object.entries(request.headers).filter(([name]) => !droppedModelHeaders.has(name)),
    );
    headers.authorization = `Bearer ${token}`;
    const upstream = requestModel(
      { method: request.method, path: request.url, headers },
      (reply) => {
        log(
          fork.id,
          `model ${request.method} ${request.url.replace(/\?.*/, '')} ${reply.statusCode}`,
        );
        response.writeHead(reply.statusCode ?? 502, reply.headers);
        reply.pipe(response);
      },
    );
    upstream.on('error', (error) => {
      log(fork.id, `failed model ${request.method} ${request.url}: ${error.code ?? error.message}`);
      if (!response.headersSent) response.writeHead(502);
      response.end();
    });
    request.pipe(upstream);
  });

  const listening = (listener, listenPort) =>
    new Promise((resolve) => listener.listen(listenPort, () => resolve(listener)));
  return Promise.all([listening(server, port), listening(modelServer, modelPort)]).then(
    ([forward, model]) => ({ forward, model }),
  );
}
