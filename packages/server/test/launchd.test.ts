import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { launchAgentPlist } from '../src/daemon/launchd.js';
import { serviceRunsFor } from '../src/daemon/service.js';

describe('launch agent', () => {
  it('runs the daemon with the installing shell PATH and restarts it only after a crash', () => {
    const plist = launchAgentPlist({
      nodePath: '/opt/node/bin/node',
      daemonEntry: '/opt/chat-explorer/dist/daemon/main.js',
      config: { ...loadConfig(), home: '/Users/me/.chat-explorer & co', port: 4517 },
      path: '/opt/node/bin:/usr/bin',
    });
    expect(plist).toContain('<string>/opt/node/bin/node</string>');
    expect(plist).toContain('<string>/opt/chat-explorer/dist/daemon/main.js</string>');
    expect(plist).toContain('<key>PATH</key>\n    <string>/opt/node/bin:/usr/bin</string>');
    expect(plist).toContain('<string>/Users/me/.chat-explorer &amp; co</string>');
    expect(plist).toMatch(/<key>SuccessfulExit<\/key>\s*<false\/>/);
  });

  it.runIf(process.platform === 'darwin')(
    'starts the daemon through the service only for the home and port it runs',
    () => {
      const config = { ...loadConfig(), home: '/Users/me/.chat-explorer', port: 4517 };
      const plistPath = join(mkdtempSync(join(tmpdir(), 'chat-explorer-launchd-')), 'agent.plist');
      expect(serviceRunsFor(config, plistPath)).toBe(false);
      writeFileSync(
        plistPath,
        launchAgentPlist({ nodePath: 'node', daemonEntry: 'main.js', config, path: '/usr/bin' }),
      );
      expect(serviceRunsFor(config, plistPath)).toBe(true);
      expect(serviceRunsFor({ ...config, port: 4999 }, plistPath)).toBe(false);
      expect(serviceRunsFor({ ...config, home: '/tmp/e2e' }, plistPath)).toBe(false);
    },
  );
});
