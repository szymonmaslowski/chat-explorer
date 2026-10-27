import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { launchAgentPlist } from '../src/daemon/launchd.js';

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
});
