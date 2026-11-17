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
  const logsPath = join(root, 'logs');
  let proxy: Server;
  let target: Server;
  let proxyPort: number;
  let targetPort: number;
  // Names resolve as the test says, all to the local target, which stands in for the internet.
  const answers: Record<string, string> = {
    'allowed.example.com': '104.16.1.34',
    'rebound.example.com': '192.168.1.10',
    'mapped.example.com': '::ffff:10.0.0.1',
  };

  beforeAll(async () => {
    mkdirSync(policiesPath);
    mkdirSync(logsPath);
    target = createServer((incoming, outgoing) =>
      outgoing.end(
        `hello from ${incoming.url}${incoming.headers['proxy-authorization'] ? ' with the sign-in' : ''}`,
      ),
    );
    await new Promise<void>((resolve) => target.listen(0, '127.0.0.1', resolve));
    targetPort = (target.address() as AddressInfo).port;
    proxy = await startEgressProxy({
      port: 0,
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
        connect(host === '104.16.1.34' ? targetPort : port, '127.0.0.1', onConnect),
    });
    proxyPort = (proxy.address() as AddressInfo).port;
  });

  afterAll(() => {
    proxy.close();
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
});
