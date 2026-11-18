import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { splitHostPort } from '@chat-explorer/shared/network.js';
import { knownHostsName, type Credential } from './access-config.js';

// Where a coding container finds its credentials and the SSH and git config that use them. The
// runner writes the folder fresh for each container and mounts it read-only.
export const credentialsMount = '/credentials';

// GitHub's SSH host keys, as api.github.com/meta lists them, for github.com and for SSH over port
// 443. Kept here, not in the image, so a key rotation needs no image rebuild. A test checks them
// against the fingerprints GitHub publishes.
export const githubHostKeys = [
  'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl',
  'ecdsa-sha2-nistp256 AAAAE2VjZHNhLXNoYTItbmlzdHAyNTYAAAAIbmlzdHAyNTYAAABBBEmKSENjQEezOmxkZMy7opKgwFB9nkt5YRrYMjNuG5N87uRgg6CLrbo5wAdT/y6v0mKV0U2w0WZ2YB/++Tpockg=',
  'ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABgQCj7ndNxQowgcQnjshcLrqPEiiphnt+VTTvDP6mHBL9j1aNUkY4Ue1gvwnGLVlOhGeYrnZaMgRK6+PKCUXaDbC7qtbW8gIkhL7aGCsOr/C56SJMy/BCZfxd1nWzAOxSDPgVsmerOBYfNqltV9/hWCqBywINIR+5dIg6JTJ72pcEpEjcYgXkE2YEFXV1JHnsKgbLWNlhScqb2UmyRkQyytRLtL+38TGxkxCflmO+5Z8CSSNY7GidjMIZ7Q4zMjA2n1nGrlTDkzwDCsw+wqFPGQA179cnfGWOWRVruj16z6XyvxvjJwbz0wQZ75XK5tKSb7FNyeIEs4TT4jk+S4dhPeAUC5y+bDYirYgM4GC7uEnztnZyaVWQ7B381AK4Qdrwt51ZqExKbQpTUNn+EjqoTwvqNj4kqx5QUCI0ThS/YkOxJCXmPUWZbhjpCg56i+2aB6CmK2JGhn57K5mj0MNdBXA4/WnwH6XoPWJzK5Nyu2zB3nAZp+S5hpQs+p1vN1/wsjk=',
];
const githubSshHosts = ['github.com:22', 'ssh.github.com:443'];

export const runnerKnowsHostKey = (hostPort: string) => githubSshHosts.includes(hostPort);

// ssh's ProxyCommand: a tunnel through the egress proxy, signed in with the container's pass from
// HTTPS_PROXY. Node's own modules only, since the image has Node and nothing like socat.
const connectScript = `import net from 'node:net';
const [host, port] = process.argv.slice(2);
const proxy = new URL(process.env.HTTPS_PROXY);
const signIn = Buffer.from(decodeURIComponent(proxy.username) + ':' + decodeURIComponent(proxy.password)).toString('base64');
const socket = net.connect(Number(proxy.port), proxy.hostname, () => {
  socket.write('CONNECT ' + host + ':' + port + ' HTTP/1.1\\r\\nHost: ' + host + ':' + port + '\\r\\nProxy-Authorization: Basic ' + signIn + '\\r\\n\\r\\n');
});
let reply = Buffer.alloc(0);
const onReply = (chunk) => {
  reply = Buffer.concat([reply, chunk]);
  const end = reply.indexOf('\\r\\n\\r\\n');
  if (end < 0) return;
  socket.off('data', onReply);
  const head = reply.subarray(0, end).toString();
  if (head.split(' ')[1] !== '200') {
    process.stderr.write('The sandbox refused ' + host + ':' + port + ': ' + reply.subarray(end + 4).toString() + '\\n');
    process.exit(1);
  }
  process.stdout.write(reply.subarray(end + 4));
  socket.pipe(process.stdout);
  process.stdin.pipe(socket);
};
socket.on('data', onReply);
socket.on('error', (error) => {
  process.stderr.write('Could not reach the sandbox proxy: ' + error.message + '\\n');
  process.exit(1);
});
socket.on('close', () => process.exit(0));
`;

const fileOf = (index: number, credential: Credential) =>
  `credential-${index}.${credential.type === 'token' ? 'token' : 'key'}`;

function sshConfig(credentials: Credential[]) {
  const inside = (file: string) => `${credentialsMount}/${file}`;
  const hostBlocks = credentials.flatMap((credential, index) =>
    credential.type !== 'ssh-key'
      ? []
      : credential.hosts.map((rule) => {
          const { host, port } = splitHostPort(rule.pattern);
          return [
            `Host ${host}`,
            `  Port ${port}`,
            '  User git',
            `  IdentityFile ${inside(fileOf(index, credential))}`,
            '  IdentitiesOnly yes',
          ].join('\n');
        }),
  );
  return [
    ...hostBlocks,
    [
      'Host *',
      `  UserKnownHostsFile ${inside('known_hosts')}`,
      '  StrictHostKeyChecking yes',
      // NODE_USE_ENV_PROXY makes Node warn on stderr, which ssh would show with every command.
      `  ProxyCommand node --no-warnings ${inside('connect.mjs')} %h %p`,
    ].join('\n'),
    '',
  ].join('\n\n');
}

function knownHosts(credentials: Credential[]) {
  const github = githubSshHosts.flatMap((hostPort) =>
    githubHostKeys.map((key) => `${knownHostsName(hostPort)} ${key}`),
  );
  return [...github, ...credentials.flatMap((credential) => credential.knownHosts), ''].join('\n');
}

// System-level git config, so the agent's own `git config --global` still works.
function gitConfig(credentials: Credential[]) {
  const tokenHelpers = credentials.flatMap((credential, index) =>
    credential.type !== 'token'
      ? []
      : credential.hosts.map((rule) => {
          const { host, port } = splitHostPort(rule.pattern);
          const url = port === 443 ? `https://${host}` : `https://${host}:${port}`;
          const file = `${credentialsMount}/${fileOf(index, credential)}`;
          return `[credential "${url}"]\n\thelper = "!f() { test \\"$1\\" = get && echo username=${credential.username} && echo password=$(cat ${file}); }; f"\n`;
        }),
  );
  // git would first try the proxy without its sign-in, to learn which kind it wants.
  const proxy = '[http]\n\tproxyAuthMethod = basic\n';
  const ssh = `[core]\n\tsshCommand = ssh -F ${credentialsMount}/ssh_config\n`;
  return [ssh, proxy, ...tokenHelpers].join('');
}

// Writes the folder a container mounts at /credentials: copies of the fork's secrets, and the
// config that uses them. Removed when the container ends, so the copies don't outlive it.
export function writeCredentialFiles(folder: string, credentials: Credential[]) {
  rmSync(folder, { recursive: true, force: true });
  mkdirSync(folder, { recursive: true, mode: 0o700 });
  const write = (name: string, text: string) =>
    writeFileSync(join(folder, name), text, { mode: 0o600 });
  credentials.forEach((credential, index) => {
    const target = join(folder, fileOf(index, credential));
    copyFileSync(credential.file, target);
    chmodSync(target, 0o600);
  });
  write('ssh_config', sshConfig(credentials));
  write('known_hosts', knownHosts(credentials));
  write('gitconfig', gitConfig(credentials));
  write('connect.mjs', connectScript);
}

export const removeCredentialFiles = (folder: string) =>
  rmSync(folder, { recursive: true, force: true });

// Copies left by containers of a runner that stopped without cleaning up, such as after a crash.
// No container runs yet when the runner starts.
export function removeLeftoverCredentials(forksPath: string, folderOf: (forkId: string) => string) {
  if (!existsSync(forksPath)) return;
  for (const forkId of readdirSync(forksPath)) removeCredentialFiles(folderOf(forkId));
}
