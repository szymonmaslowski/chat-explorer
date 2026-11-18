export const registryNames = ['npm', 'pypi', 'rust', 'go'] as const;
export type RegistryName = (typeof registryNames)[number];

// What a coding fork's container may reach, besides the model and the chat tools: hosts the
// reader allowed, the package registries they ticked, and credentials of the runner's config by
// name, each bringing the hosts it is paired with there.
export interface ForkNetwork {
  hosts: string[];
  registries: RegistryName[];
  credentials: string[];
}

export const noNetwork: ForkNetwork = { hosts: [], registries: [], credentials: [] };

// As the runner's config may name a credential.
export const credentialNamePattern = /^[A-Za-z0-9][\w .-]{0,63}$/;
export const maxCredentials = 20;

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

export const splitHostPort = (hostPort: string) => {
  const colon = hostPort.lastIndexOf(':');
  return { host: hostPort.slice(0, colon), port: Number(hostPort.slice(colon + 1)) };
};

// A host:port against an entry of a runner's host list: the same host:port, or *.domain:port for
// every name under that domain.
export function matchesHostPattern(pattern: string, hostPort: string) {
  if (!pattern.startsWith('*.')) return pattern === hostPort;
  const domain = splitHostPort(pattern.slice(2));
  const target = splitHostPort(hostPort);
  return target.port === domain.port && target.host.endsWith(`.${domain.host}`);
}

// The fewest hosts each package manager needs to install packages. Where a registry splits work
// over several hosts, each is needed: PyPI's index and its files, Go's modules and the checksum
// database that verifies them, Cargo's index and its downloads.
export const packageRegistries: Record<RegistryName, { label: string; hosts: string[] }> = {
  npm: { label: 'npm', hosts: ['registry.npmjs.org:443'] },
  pypi: { label: 'Python: PyPI', hosts: ['pypi.org:443', 'files.pythonhosted.org:443'] },
  // rustup's hosts too, since the image has no Rust: it installs the toolchain itself.
  rust: {
    label: 'Rust: crates.io and rustup',
    hosts: [
      'index.crates.io:443',
      'static.crates.io:443',
      'sh.rustup.rs:443',
      'static.rust-lang.org:443',
    ],
  },
  go: { label: 'Go modules', hosts: ['proxy.golang.org:443', 'sum.golang.org:443'] },
};

export const networkHosts = (network: Pick<ForkNetwork, 'hosts' | 'registries'>) => [
  ...new Set([
    ...network.registries.flatMap((name) => packageRegistries[name].hosts),
    ...network.hosts,
  ]),
];
