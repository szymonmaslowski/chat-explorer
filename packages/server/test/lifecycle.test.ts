import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { compareVersions, ensureDaemon, probe, stopDaemon } from '../src/daemon/control.js';

const daemonEntry = fileURLToPath(new URL('./fixtures/fake-daemon.mjs', import.meta.url));
let config: ReturnType<typeof loadConfig>;

const withFakeVersion = async <Result>(version: string, run: () => Promise<Result>) => {
  const previous = process.env.FAKE_DAEMON_VERSION;
  process.env.FAKE_DAEMON_VERSION = version;
  try {
    return await run();
  } finally {
    if (previous === undefined) delete process.env.FAKE_DAEMON_VERSION;
    else process.env.FAKE_DAEMON_VERSION = previous;
  }
};

beforeEach(() => {
  process.env.CHAT_EXPLORER_HOME = mkdtempSync(join(tmpdir(), 'chat-explorer-test-'));
  process.env.CHAT_EXPLORER_PORT = String(40_000 + Math.floor(Math.random() * 20_000));
  config = loadConfig();
});

afterEach(async () => {
  await stopDaemon(config).catch(() => {});
  rmSync(config.home, { recursive: true, force: true });
});

describe('compareVersions', () => {
  it('orders versions numerically, with prereleases first', () => {
    expect(compareVersions('0.10.0', '0.9.9')).toBe(1);
    expect(compareVersions('1.0.0', '1.0.0')).toBe(0);
    expect(compareVersions('1.0.0-beta', '1.0.0')).toBe(-1);
    expect(compareVersions('1.2.3', '1.3.0')).toBe(-1);
  });
});

describe('ensureDaemon', () => {
  it('starts one daemon when two starts race', async () => {
    const [first, second] = await withFakeVersion('1.0.0', () =>
      Promise.all([
        ensureDaemon(config, { version: '1.0.0', apiVersion: 1, daemonEntry }),
        ensureDaemon(config, { version: '1.0.0', apiVersion: 1, daemonEntry }),
      ]),
    );
    expect(first.health.pid).toBe(second.health.pid);
    const current = await probe(config.baseUrl);
    expect(current.state === 'running' && current.health.pid).toBe(first.health.pid);
  });

  it('reuses a daemon with the same version', async () => {
    const started = await withFakeVersion('1.0.0', () =>
      ensureDaemon(config, { version: '1.0.0', apiVersion: 1, daemonEntry }),
    );
    const again = await ensureDaemon(config, { version: '1.0.0', apiVersion: 1, daemonEntry });
    expect(again).toEqual({ health: started.health, started: false });
  });

  it('replaces an older daemon', async () => {
    const old = await withFakeVersion('1.0.0', () =>
      ensureDaemon(config, { version: '1.0.0', apiVersion: 1, daemonEntry }),
    );
    const upgraded = await withFakeVersion('1.1.0', () =>
      ensureDaemon(config, { version: '1.1.0', apiVersion: 1, daemonEntry }),
    );
    expect(upgraded.started).toBe(true);
    expect(upgraded.health.version).toBe('1.1.0');
    expect(upgraded.health.pid).not.toBe(old.health.pid);
  });

  it('leaves a newer daemon alone when the API version matches', async () => {
    const newer = await withFakeVersion('2.0.0', () =>
      ensureDaemon(config, { version: '2.0.0', apiVersion: 1, daemonEntry }),
    );
    const fromOldShim = await ensureDaemon(config, {
      version: '1.0.0',
      apiVersion: 1,
      daemonEntry,
    });
    expect(fromOldShim).toEqual({ health: newer.health, started: false });
  });

  it('asks for a session restart when a newer daemon speaks another API version', async () => {
    await withFakeVersion('2.0.0', () =>
      ensureDaemon(config, { version: '2.0.0', apiVersion: 1, daemonEntry }),
    );
    await expect(
      ensureDaemon(config, { version: '1.0.0', apiVersion: 0, daemonEntry }),
    ).rejects.toThrow('restart this Claude session');
  });

  describe('with another program on the port', () => {
    let foreign: Server;

    beforeEach(async () => {
      foreign = createServer((_request, response) => response.end('<html>hello</html>'));
      await new Promise<void>((resolve) => foreign.listen(config.port, '127.0.0.1', resolve));
    });

    afterEach(() => {
      foreign.close();
    });

    it('fails with a message naming the port', async () => {
      await expect(
        ensureDaemon(config, { version: '1.0.0', apiVersion: 1, daemonEntry }),
      ).rejects.toThrow(`Port ${config.port} is used by another program`);
    });
  });
});
