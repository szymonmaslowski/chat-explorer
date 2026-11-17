import { describe, expect, it } from 'vitest';
import { isHostPort, networkHosts, registryHosts } from '@chat-explorer/shared/network.js';

describe('an allowed host entry', () => {
  it('takes a host name with a dot and a port', () => {
    for (const entry of ['github.com:443', 'ssh.github.com:443', 'git.example.co.uk:2222']) {
      expect(isHostPort(entry)).toBe(true);
    }
  });

  it('refuses addresses, wildcards, missing or impossible ports and anything else', () => {
    for (const entry of [
      'github.com',
      'github.com:0',
      'github.com:65536',
      'localhost:80',
      '192.168.1.1:22',
      '[::1]:443',
      '*.github.com:443',
      'GitHub.com:443',
      'github.com:443/path',
      'github.com:443 --flag',
      'http://github.com:443',
      '-x.com:443',
      'example.123:443',
      '',
    ]) {
      expect(isHostPort(entry), entry).toBe(false);
    }
  });
});

describe("a fork's allowed hosts", () => {
  it('adds the registries when the preset is on, once each', () => {
    expect(networkHosts({ hosts: ['github.com:443'], registries: false })).toEqual([
      'github.com:443',
    ]);
    const withPreset = networkHosts({ hosts: ['registry.npmjs.org:443'], registries: true });
    expect(withPreset).toEqual(registryHosts);
  });
});
