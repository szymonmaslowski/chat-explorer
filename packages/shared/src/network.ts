export const registryNames = ['npm', 'pypi', 'rust', 'go'] as const;
export type RegistryName = (typeof registryNames)[number];

// What a coding fork's container may reach, besides the model and the chat tools: hosts the
// reader allowed, and the package registries they ticked.
export interface ForkNetwork {
  hosts: string[];
  registries: RegistryName[];
}

export const noNetwork: ForkNetwork = { hosts: [], registries: [] };

export const maxAllowedHosts = 100;

// A host name with a dot and a port, such as github.com:443. Never an IP address: the proxy checks
// the address a name resolves to, and a literal address would skip the name a reader can judge.
const hostPortPattern =
  /^(?=.{1,253}:)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,61}[a-z0-9]:(\d{1,5})$/;

export function isHostPort(entry: string) {
  const match = hostPortPattern.exec(entry);
  if (!match) return false;
  const port = Number(match[1]);
  return port >= 1 && port <= 65_535;
}

// The hosts each package manager downloads from.
export const packageRegistries: Record<RegistryName, { label: string; hosts: string[] }> = {
  npm: {
    label: 'npm, Yarn, pnpm',
    hosts: ['registry.npmjs.org:443', 'registry.yarnpkg.com:443', 'repo.yarnpkg.com:443'],
  },
  pypi: { label: 'Python: PyPI', hosts: ['pypi.org:443', 'files.pythonhosted.org:443'] },
  // rustup's hosts too, since the image has no Rust: it installs the toolchain itself.
  rust: {
    label: 'Rust: crates.io and rustup',
    hosts: [
      'crates.io:443',
      'index.crates.io:443',
      'static.crates.io:443',
      'sh.rustup.rs:443',
      'static.rust-lang.org:443',
    ],
  },
  go: { label: 'Go modules', hosts: ['proxy.golang.org:443', 'sum.golang.org:443'] },
};

export const networkHosts = (network: ForkNetwork) => [
  ...new Set([
    ...network.registries.flatMap((name) => packageRegistries[name].hosts),
    ...network.hosts,
  ]),
];
