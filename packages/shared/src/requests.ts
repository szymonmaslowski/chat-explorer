import type { ClaudeModel } from './models.js';
import type { RegistryName } from './network.js';
import type { ArrangeBoardInput, ForkAwareness } from './types.js';

// What Claude asks to do, waiting for the user's approval on a card in the conversation. The
// backend runs the stored, approved version; Claude has no part in it after asking.

export interface NewNoteInput {
  topic?: string | undefined;
  description?: string | undefined;
  category?: string | undefined;
}

// The settings a request may set on a fork. Left out: unchanged.
export interface ForkSettingsChanges {
  title?: string | undefined;
  awareness?: ForkAwareness | undefined;
  coding?: boolean | undefined;
  // Null follows the chat's model.
  model?: ClaudeModel | null | undefined;
  hosts?: string[] | undefined;
  registries?: RegistryName[] | undefined;
  credentials?: string[] | undefined;
}

export type RequestAction =
  | {
      kind: 'fork';
      // Picked when Claude asks, so later requests can name the fork before it exists.
      forkId: string;
      title: string;
      // The new fork's first message, as if the user had typed it.
      brief: string;
      awareness: ForkAwareness;
      coding: boolean;
      model: ClaudeModel | null;
      hosts: string[];
      registries: RegistryName[];
      credentials: string[];
    }
  | { kind: 'message'; forkId: string; text: string }
  | { kind: 'fork_settings'; forkId: string; changes: ForkSettingsChanges }
  | { kind: 'note_group'; groupId: string; name: string; checklist: boolean }
  | { kind: 'notes'; groupId: string; notes: NewNoteInput[]; sourceMessageId: string | null }
  | {
      kind: 'note_update';
      noteId: string;
      topic?: string | undefined;
      description?: string | undefined;
      category?: string | null | undefined;
      checked?: boolean | undefined;
    }
  | { kind: 'note_group_change'; noteId: string; groupId: string }
  | { kind: 'note_category'; groupId: string; from: string; to: string | null }
  | { kind: 'note_deletion'; noteId: string }
  | { kind: 'board'; input: ArrangeBoardInput };

export type RequestKind = RequestAction['kind'];

// done: it ran. failed: it was refused when it ran, with the reason. skipped: it targets a fork or
// group another item was to create, which wasn't. unticked: left out of the approval. rejected:
// the whole card was rejected.
export type RequestItemOutcome = 'done' | 'failed' | 'skipped' | 'unticked' | 'rejected';

export interface RequestItem {
  id: string;
  // As Claude asked.
  original: RequestAction;
  // As approved, with the user's edits; null until decided.
  final: RequestAction | null;
  outcome: RequestItemOutcome | null;
  // Why it failed or was skipped.
  detail: string | null;
  // The fork, note, group or message it made.
  resultId: string | null;
}

export type RequestStatus = 'waiting' | 'approved' | 'rejected';
export type RequestDecider = 'user' | 'autonomous';
export type RequestOrigin = 'fork' | 'terminal';

export interface ActionRequest {
  id: string;
  explorationId: string;
  // The fork whose conversation shows the card: the one whose Claude asked.
  forkId: string;
  // The fork's newest message when Claude asked; the card shows after it and its answers.
  afterMessageId: string | null;
  requestedBy: RequestOrigin;
  items: RequestItem[];
  status: RequestStatus;
  decidedBy: RequestDecider | null;
  decidedAt: number | null;
  // The user's reason for a rejection, when given.
  reason: string | null;
  // Areas of the Autonomous setting the user turned on for the fork with this card's Approve.
  allowedAreas: AutonomousArea[];
  // The user's edits while the card waits, saved so a reload or another device shows them; null
  // when there are none, and dropped once the card is decided.
  draft: RequestDraft | null;
  createdAt: number;
  updatedAt: number;
}

// What the user changed on a waiting card so far: ticks, edited items, the reason and the areas
// to allow. Items not named are ticked and as Claude asked.
export interface RequestDraft {
  items: { id: string; selected: boolean; action: RequestAction }[];
  reason: string;
  allowAreas: AutonomousArea[];
  savedAt: number;
}

// The user's decision on a card: each item ticked or not, with its edited values.
export interface RequestDecision {
  decision: 'approve' | 'reject';
  items?: { id: string; selected: boolean; action?: RequestAction }[];
  reason?: string | null;
  // Areas to turn on in the fork's Autonomous setting along with the approval; Reject ignores it.
  allowAreas?: AutonomousArea[];
}

// Areas of actions a fork's Autonomous setting can let run without a card.
export const autonomousAreas = ['notes', 'board', 'messages', 'forks', 'fork_options'] as const;
export type AutonomousArea = (typeof autonomousAreas)[number];

export const autonomousAreaLabels: Record<AutonomousArea, string> = {
  notes: 'Notes: add, update, move, rename, delete',
  board: 'Board: columns and moving forks',
  messages: 'Messages to existing forks',
  forks: 'New forks',
  fork_options: 'Other fork options: awareness and title',
};

export const defaultAutonomousForksPerHour = 5;

// The card's checkbox for an area: "Allow notes actions without asking in this fork".
export const allowAreaNames: Record<AutonomousArea, string> = {
  notes: 'notes actions',
  board: 'board actions',
  messages: 'messages to forks',
  forks: 'new forks',
  fork_options: 'fork option changes',
};

export const allowAreaLabel = (area: AutonomousArea) =>
  `Allow ${allowAreaNames[area]} without asking in this fork`;

// The areas a card may offer to allow: those of its ticked items that Autonomous can cover, in
// the setting's order.
export function allowableAreas(actions: RequestAction[]): AutonomousArea[] {
  const present = new Set(actions.map(autonomousAreaOf).filter((area) => area !== null));
  return autonomousAreas.filter((area) => present.has(area));
}

const hasNetwork = (values: {
  hosts?: string[] | undefined;
  registries?: string[] | undefined;
  credentials?: string[] | undefined;
}) =>
  (values.hosts?.length ?? 0) > 0 ||
  (values.registries?.length ?? 0) > 0 ||
  (values.credentials?.length ?? 0) > 0;

// The area an action belongs to, or null when no Autonomous setting may cover it: container
// settings (coding, hosts, registries), credentials, and the model are always the user's click.
export function autonomousAreaOf(action: RequestAction): AutonomousArea | null {
  switch (action.kind) {
    case 'fork':
      return action.coding || action.model !== null || hasNetwork(action) ? null : 'forks';
    case 'message':
      return 'messages';
    case 'fork_settings': {
      const { title: _title, awareness: _awareness, ...rest } = action.changes;
      const others = Object.values(rest).some((value) => value !== undefined);
      return others ? null : 'fork_options';
    }
    case 'board':
      return 'board';
    default:
      return 'notes';
  }
}

// The fork or note group an action works on, when another item may have to create it first.
export function targetOf(action: RequestAction): { kind: 'fork' | 'group'; id: string } | null {
  switch (action.kind) {
    case 'message':
    case 'fork_settings':
      return { kind: 'fork', id: action.forkId };
    case 'notes':
    case 'note_group_change':
    case 'note_category':
      return { kind: 'group', id: action.groupId };
    case 'board':
      return action.input.forkId ? { kind: 'fork', id: action.input.forkId } : null;
    default:
      return null;
  }
}

// The fork or note group an action creates, under the id picked when Claude asked.
export function createdBy(action: RequestAction): { kind: 'fork' | 'group'; id: string } | null {
  if (action.kind === 'fork') return { kind: 'fork', id: action.forkId };
  if (action.kind === 'note_group') return { kind: 'group', id: action.groupId };
  return null;
}

// Does the action carry a credential, which the fork can read?
export const attachesCredential = (action: RequestAction) =>
  (action.kind === 'fork' && action.credentials.length > 0) ||
  (action.kind === 'fork_settings' && (action.changes.credentials?.length ?? 0) > 0);

// A short line saying what an action does, for the card and for Claude.
export function describeAction(action: RequestAction): string {
  switch (action.kind) {
    case 'fork':
      return `Start a new fork "${action.title}" (${action.forkId})${action.coding ? ', coding on' : ''}`;
    case 'message':
      return `Message fork ${action.forkId}`;
    case 'fork_settings':
      return `Change the settings of fork ${action.forkId}`;
    case 'note_group':
      return `Add the note group "${action.name || 'default name'}"`;
    case 'notes':
      return `Add ${action.notes.length} note${action.notes.length === 1 ? '' : 's'} to group ${action.groupId}`;
    case 'note_update':
      return `Update note ${action.noteId}`;
    case 'note_group_change':
      return `Move note ${action.noteId} to group ${action.groupId}`;
    case 'note_category':
      return action.to === null
        ? `Remove the category "${action.from}" in group ${action.groupId}`
        : `Rename the category "${action.from}" to "${action.to}" in group ${action.groupId}`;
    case 'note_deletion':
      return `Delete note ${action.noteId}`;
    case 'board':
      return `Board: ${action.input.action.replace('_', ' ')}`;
  }
}

// The fields of an item the user changed, by name.
export function editedFields(original: RequestAction, final: RequestAction | null): string[] {
  if (!final) return [];
  const flat = (action: RequestAction): Record<string, unknown> => {
    const { kind: _kind, ...rest } = action;
    if (action.kind === 'fork_settings') return { forkId: action.forkId, ...action.changes };
    if (action.kind === 'board') return { ...action.input };
    return rest;
  };
  const before = flat(original);
  const after = flat(final);
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  return [...keys].filter((key) => JSON.stringify(before[key]) !== JSON.stringify(after[key]));
}
