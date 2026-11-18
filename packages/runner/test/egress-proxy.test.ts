import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, request, type Server } from 'node:http';
import { connect, type AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { isPublicAddress, startEgressProxy } from '../proxy/egress-proxy.mjs';

describe('a public address', () => {
  it('is any address outside this machine, the local network and reserved ranges', () => {
    for (const address of ['104.16.1.34', '2606:4700::6810:84e5', '::ffff:104.16.1.34']) {
      expect(isPublicAddress(address), address).toBe(true);
    }
    for (const address of [
      '127.0.0.1',
      '10.1.2.3',
      '172.20.0.1',
      '192.168.1.10',
      '169.254.169.254',
      '100.64.0.1',
      '0.0.0.0',
      '::1',
      '::',
      'fe80::1',
      'fd00::1',
      'fd00:ec2::254',
      '::ffff:192.168.1.10',
      '::ffff:127.0.0.1',
      '::ffff:c0a8:10a',
      '64:ff9b::c0a8:10a',
      'not an address',
    ]) {
      expect(isPublicAddress(address), address).toBe(false);
    }
  });
});

describe('the egress proxy', () => {
  const root = mkdtempSync(join(tmpdir(), 'egress-proxy-'));
  const policiesPath = join(root, 'policies');
  const secretsPath = join(root, 'secrets');
  const logsPath = join(root, 'logs');
  let proxy: Server;
  let model: Server;
  let upstream: Server;
  let modelPort: number;
  const upstreamSaw: { authorization?: string; apiKey?: string; cookie?: string; path?: string }[] =
    [];
  let target: Server;
  let proxyPort: number;
  let targetPort: number;
  // Names resolve as the test says, all to the local target, which stands in for the internet.
  const answers: Record<string, string> = {
    'allowed.example.com': '104.16.1.34',
    'rebound.example.com': '192.168.1.10',
    'mapped.example.com': '::ffff:10.0.0.1',
    'git.home.example.com': '192.168.1.20',
    'secret.example.com': '104.16.1.34',
  };

  beforeAll(async () => {
    mkdirSync(policiesPath);
    mkdirSync(logsPath);
    mkdirSync(secretsPath);
    writeFileSync(join(secretsPath, 'model-token'), 'sk-ant-oat01-real\n');
    upstream = createServer((incoming, outgoing) => {
      upstreamSaw.push({
        authorization: incoming.headers.authorization,
        apiKey: incoming.headers['x-api-key'] as string | undefined,
        cookie: incoming.headers.cookie,
        path: incoming.url,
      });
      outgoing
        .writeHead(200, { 'content-type': 'text/event-stream' })
        .end('event: message_stop\n\n');
    });
    await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
    const upstreamPort = (upstream.address() as AddressInfo).port;
    target = createServer((incoming, outgoing) =>
      outgoing.end(
        `hello from ${incoming.url}${incoming.headers['proxy-authorization'] ? ' with the sign-in' : ''}`,
      ),
    );
    await new Promise<void>((resolve) => target.listen(0, '127.0.0.1', resolve));
    targetPort = (target.address() as AddressInfo).port;
    ({ forward: proxy, model } = await startEgressProxy({
      port: 0,
      modelPort: 0,
      secretsPath,
      requestModel: (requestOptions, onResponse) =>
        request({ ...requestOptions, host: '127.0.0.1', port: upstreamPort }, onResponse),
      policiesPath,
      logsPath,
      alwaysAllowed: ['api.anthropic.com:443'],
      toolsHost: `localhost:${targetPort}`,
      lookup: async (host) => {
        const address = answers[host];
        if (!address) throw new Error('ENOTFOUND');
        return [{ address, family: address.includes(':') ? 6 : 4 }];
      },
      maxConnections: 2,
      // Every public address stands for the internet, played here by the local target.
      connect: (port, host, onConnect) =>
        connect(
          ['104.16.1.34', '192.168.1.20'].includes(host) ? targetPort : port,
          '127.0.0.1',
          onConnect,
        ),
    }));
    proxyPort = (proxy.address() as AddressInfo).port;
    modelPort = (model.address() as AddressInfo).port;
  });

  afterAll(() => {
    proxy.close();
    model.close();
    upstream.close();
    target.close();
    rmSync(root, { recursive: true, force: true });
  });

  const allow = (id: string, hosts: string[], token = `${id}-token`) =>
    writeFileSync(join(policiesPath, `${id}.json`), JSON.stringify({ token, hosts }));
  const signIn = (id: string, token = `${id}-token`) =>
    `Basic ${Buffer.from(`${id}:${token}`).toString('base64')}`;

  // A CONNECT the way a client in the container sends it. The proxy connects to the address it
  // resolved, so these tests point the allowed names at the local target by port.
  function tunnel(hostPort: string, authorization?: string) {
    return new Promise<{ status: number; socket: ReturnType<typeof connect> }>((resolve) => {
      const socket = connect(proxyPort, '127.0.0.1', () => {
        const auth = authorization ? `Proxy-Authorization: ${authorization}\r\n` : '';
        socket.write(`CONNECT ${hostPort} HTTP/1.1\r\nHost: ${hostPort}\r\n${auth}\r\n`);
      });
      socket.once('data', (chunk) => {
        resolve({ status: Number(/^HTTP\/1\.1 (\d+)/.exec(chunk.toString())?.[1]), socket });
      });
    });
  }
  const status = async (hostPort: string, authorization?: string) => {
    const { status: code, socket } = await tunnel(hostPort, authorization);
    socket.destroy();
    return code;
  };
  const logOf = (id: string) => {
    try {
      return readFileSync(join(logsPath, `${id}.log`), 'utf8');
    } catch {
      return '';
    }
  };

  it('refuses a container that does not sign in with its own token', async () => {
    allow('fork_a', ['allowed.example.com:443']);
    expect(await status('allowed.example.com:443')).toBe(407);
    expect(await status('allowed.example.com:443', signIn('fork_a', 'wrong'))).toBe(407);
    expect(await status('allowed.example.com:443', signIn('fork_b'))).toBe(407);
    expect(await status('allowed.example.com:443', signIn('../fork_a'))).toBe(407);
  });

  it('lets a fork through only to hosts on its own list, and logs both', async () => {
    allow('fork_a', ['allowed.example.com:443']);
    allow('fork_b', []);
    expect(await status('allowed.example.com:443', signIn('fork_b'))).toBe(403);
    expect(await status('allowed.example.com:22', signIn('fork_a'))).toBe(403);
    await expect
      .poll(() => logOf('fork_b'))
      .toMatch(/denied allowed\.example\.com:443: not on this fork's list/);
    expect(await status('allowed.example.com:443', signIn('fork_a'))).toBe(200);
    await expect
      .poll(() => logOf('fork_a'))
      .toMatch(/allowed allowed\.example\.com:443 \(104\.16\.1\.34\)/);
  });

  it('applies a changed list to the next connection', async () => {
    allow('fork_c', []);
    expect(await status('allowed.example.com:443', signIn('fork_c'))).toBe(403);
    allow('fork_c', ['allowed.example.com:443']);
    expect(await status('allowed.example.com:443', signIn('fork_c'))).toBe(200);
  });

  it('refuses an allowed name that resolves to a private address, in any spelling', async () => {
    allow('fork_d', [
      'rebound.example.com:443',
      'mapped.example.com:443',
      'missing.example.com:443',
    ]);
    expect(await status('rebound.example.com:443', signIn('fork_d'))).toBe(403);
    expect(await status('mapped.example.com:443', signIn('fork_d'))).toBe(403);
    expect(await status('missing.example.com:443', signIn('fork_d'))).toBe(403);
    await expect
      .poll(() => logOf('fork_d'))
      .toMatch(/denied rebound\.example\.com:443: it resolves to a private address/);
  });

  it("lets a host the runner's config allows on your own network resolve there", async () => {
    const policy = (privateHosts: string[]) =>
      writeFileSync(
        join(policiesPath, 'fork_h.json'),
        JSON.stringify({
          token: 'fork_h-token',
          hosts: ['git.home.example.com:2222'],
          privateHosts,
        }),
      );
    policy([]);
    expect(await status('git.home.example.com:2222', signIn('fork_h'))).toBe(403);
    policy(['git.home.example.com:2222']);
    expect(await status('git.home.example.com:2222', signIn('fork_h'))).toBe(200);
  });

  it('never names a hidden host in the logs, allowed or denied', async () => {
    writeFileSync(
      join(policiesPath, 'fork_i.json'),
      JSON.stringify({
        token: 'fork_i-token',
        hosts: ['secret.example.com:443'],
        hiddenHosts: ['secret.example.com:443', 'other-secret.example.com:443'],
      }),
    );
    expect(await status('secret.example.com:443', signIn('fork_i'))).toBe(200);
    expect(await status('other-secret.example.com:443', signIn('fork_i'))).toBe(403);
    expect(await status('secret.example.com:443')).toBe(407);
    await expect
      .poll(() => logOf('fork_i'))
      .toMatch(/denied a hidden host: not on this fork's list/);
    expect(logOf('fork_i')).toMatch(/allowed a hidden host/);
    expect(logOf('fork_i') + logOf('_unknown')).not.toMatch(/secret/);
  });

  it('forwards plain HTTP to the tools host only, and keeps the sign-in from it', async () => {
    allow('fork_e', ['allowed.example.com:80']);
    const get = (url: string, authorization?: string) =>
      new Promise<{ status: number; body: string }>((resolve, reject) => {
        const outgoing = request(
          {
            host: '127.0.0.1',
            port: proxyPort,
            path: url,
            headers: authorization ? { 'proxy-authorization': authorization } : {},
          },
          (incoming) => {
            let body = '';
            incoming.on('data', (chunk: Buffer) => (body += chunk.toString()));
            incoming.on('end', () => resolve({ status: incoming.statusCode ?? 0, body }));
          },
        );
        outgoing.on('error', reject);
        outgoing.end();
      });
    expect(await get(`http://localhost:${targetPort}/api/tools/mcp`, signIn('fork_e'))).toEqual({
      status: 200,
      body: 'hello from /api/tools/mcp',
    });
    expect((await get(`http://localhost:${targetPort}/x`)).status).toBe(407);
    expect((await get('http://allowed.example.com/', signIn('fork_e'))).status).toBe(403);
    await expect
      .poll(() => logOf('fork_e'))
      .toMatch(/denied plain HTTP to allowed\.example\.com:80/);
  });

  it('caps the open connections of one fork', async () => {
    allow('fork_f', []);
    const tools = `localhost:${targetPort}`;
    const first = await tunnel(tools, signIn('fork_f'));
    const second = await tunnel(tools, signIn('fork_f'));
    expect([first.status, second.status]).toEqual([200, 200]);
    expect(await status(tools, signIn('fork_f'))).toBe(429);
    first.socket.destroy();
    await expect.poll(() => status(tools, signIn('fork_f'))).toBe(200);
    second.socket.destroy();
  });

  describe('standing in for the model', () => {
    const ask = (authorization: string, path = '/v1/messages?beta=true', from = '127.0.0.1') =>
      new Promise<number>((resolve, reject) => {
        const outgoing = request(
          {
            host: from,
            port: modelPort,
            method: 'POST',
            path,
            headers: {
              authorization,
              'x-api-key': 'added',
              cookie: 'added',
              'content-type': 'application/json',
            },
          },
          (incoming) => {
            incoming.resume();
            incoming.on('end', () => resolve(incoming.statusCode ?? 0));
          },
        );
        outgoing.on('error', reject);
        outgoing.end('{}');
      });
    const dummy = (id: string, token = `${id}-token`) => `Bearer sk-ant-oat01-${id}.${token}`;

    it('swaps the dummy token for the real one and drops credentials the engine added', async () => {
      allow('fork_m', [], 'aa11bb22cc33dd44');
      expect(await ask(dummy('fork_m', 'aa11bb22cc33dd44'))).toBe(200);
      expect(upstreamSaw.at(-1)).toEqual({
        authorization: 'Bearer sk-ant-oat01-real',
        apiKey: undefined,
        cookie: undefined,
        path: '/v1/messages?beta=true',
      });
      await expect.poll(() => logOf('fork_m')).toMatch(/model POST \/v1\/messages 200/);
    });

    it('refuses a wrong token, a path outside the API, and a token whose container ended', async () => {
      allow('fork_n', [], 'ee55ff66aa77bb88');
      const sent = upstreamSaw.length;
      expect(await ask(dummy('fork_n', 'ee55ff66aa77bb89'))).toBe(401);
      expect(await ask('Bearer sk-ant-oat01-real')).toBe(401);
      expect(await ask(dummy('fork_n', 'ee55ff66aa77bb88'), '/api/oauth/profile')).toBe(404);
      rmSync(join(policiesPath, 'fork_n.json'));
      expect(await ask(dummy('fork_n', 'ee55ff66aa77bb88'))).toBe(401);
      expect(upstreamSaw.length).toBe(sent);
    });

    it('works only from the address its container first used', async () => {
      allow('fork_p', [], '0011223344556677');
      expect(await ask(dummy('fork_p', '0011223344556677'), undefined, '127.0.0.1')).toBe(200);
      expect(await ask(dummy('fork_p', '0011223344556677'), undefined, '::1')).toBe(401);
      await expect.poll(() => logOf('fork_p')).toMatch(/this pass belongs to another container/);
    });
  });
});
