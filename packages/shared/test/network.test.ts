import { describe, expect, it } from 'vitest';
import { isHostPort, networkHosts, packageRegistries } from '@chat-explorer/shared/network.js';

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
  it('adds the hosts of each ticked registry, once each', () => {
    expect(networkHosts({ hosts: ['github.com:443'], registries: [] })).toEqual(['github.com:443']);
    const withNpm = networkHosts({ hosts: ['registry.npmjs.org:443'], registries: ['npm'] });
    expect(withNpm).toEqual(packageRegistries.npm.hosts);
    const withRustAndGo = networkHosts({ hosts: [], registries: ['rust', 'go'] });
    expect(withRustAndGo).toEqual([...packageRegistries.rust.hosts, ...packageRegistries.go.hosts]);
    expect(withRustAndGo).not.toContain('registry.npmjs.org:443');
  });

  it('lets the GitHub box allow github.com:443 and nothing else, without repeating a typed entry', () => {
    expect(networkHosts({ hosts: [], registries: ['github'] })).toEqual(['github.com:443']);
    expect(networkHosts({ hosts: ['github.com:443'], registries: ['github'] })).toEqual([
      'github.com:443',
    ]);
  });
});
