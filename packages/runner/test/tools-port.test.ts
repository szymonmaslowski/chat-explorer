import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runtime } from '../src/container-runtime.js';
import { daemonGatewayHost, daemonHost, ensureEgress, toolsHost } from '../src/egress.js';
import { toolsUrl } from '../src/start.js';

afterEach(() => vi.restoreAllMocks());

describe("containers and the daemon's ports", () => {
  it('call the job tools on the tools port, never the main port', () => {
    expect(toolsUrl(4518)).toBe('http://host.docker.internal:4518/api/tools/mcp');
    expect(toolsHost(4518)).toBe('host.docker.internal:4518');
  });

  it('start the proxy with the tools host allowed and the main port blocked', async () => {
    const calls: string[][] = [];
    vi.spyOn(runtime, 'command').mockImplementation(async (args) => {
      calls.push(args);
      return { code: 0, output: '' };
    });
    const egressPath = mkdtempSync(join(tmpdir(), 'chat-explorer-egress-'));
    await ensureEgress({ image: 'image', port: 4517, toolsPort: 4518, egressPath });
    const run = calls.find((args) => args[0] === 'run')!;
    const environment = run[run.indexOf('--env') + 1]!;
    const options = JSON.parse(environment.replace(/^EGRESS_OPTIONS=/, ''));
    expect(options.toolsHost).toBe('host.docker.internal:4518');
    expect(options.blockedHosts).toEqual([daemonHost(4517), daemonGatewayHost(4517)]);
    expect(daemonGatewayHost(4517)).toBe('gateway.docker.internal:4517');
    expect(daemonHost(4517)).toBe('host.docker.internal:4517');
  });
});
