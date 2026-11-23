// What the request tools tell Claude, the same for a fork's tools and the terminal's.

const waits =
  'It waits for the user to approve it on a card in this conversation and returns at once with the request id; nothing runs until then. The requests you make in one turn join one card. You learn the outcome at the start of your next turn.';

export const requestToolDescriptions = {
  request_fork: `Ask to start a new fork of this chat for a piece of work: a title, the brief, and its settings. The brief is the fork's first message, written as the user would write it; say there what to do and how to report back. coding gives it a container with a shell and its own workspace, for code or for research with command-line tools; hosts, registries and credentials say what that container may reach. The result names the new fork's id, so you can request a message to it before it exists. ${waits}`,
  request_message: `Ask to send a message to another fork of this chat, as from the main fork. ${waits}`,
  request_fork_settings: `Ask to change settings of a fork of this chat: its title, whether it is aware of the chat's other forks, coding, the model, hosts, registries and credentials. Settings left out stay as they are. ${waits}`,
} as const;

export type RequestToolName = keyof typeof requestToolDescriptions;

export const requestToolFields = {
  title: 'A short title for the fork, shown on the map',
  brief: "The fork's first message: what to do, as the user would write it",
  aware: "Whether the fork hears about the chat's other forks; true by default for a new fork",
  coding: 'A container with a shell and a workspace; off by default',
  model: "sonnet or opus; null or left out follows the chat's model",
  hosts: 'host:port entries the container may reach, such as api.example.com:443',
  registries: 'Package registries the container may reach: github, npm, pypi, rust, go',
  credentials:
    "Names of credentials from the runner's config; the fork can read a credential it is given",
} as const;
