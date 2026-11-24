import { isHostPort, matchesHostPattern, maxAllowedHosts } from '@chat-explorer/shared/network.js';
import {
  autonomousAreaOf,
  createdBy,
  defaultAutonomousForksPerHour,
  describeAction,
  editedFields,
  targetOf,
  type ActionRequest,
  type RequestAction,
  type RequestDecision,
  type RequestItem,
  type RequestOrigin,
} from '@chat-explorer/shared/requests.js';
import type { Fork, RunnerCapabilities } from '@chat-explorer/shared/types.js';
import { toActionRequest, type ActionRequestRow } from '../db/rows.js';
import { StoreError } from './errors.js';
import { newId } from './ids.js';
import type { RunStore } from './runs.js';
import type { ChatStore } from './store.js';

const requestIdPrefix = 'req_';
const hourMs = 60 * 60 * 1000;
// Long texts in what goes back to Claude are cut; the card shows them whole.
const outcomeTextLength = 300;

const cut = (text: string) =>
  text.length > outcomeTextLength ? `${text.slice(0, outcomeTextLength - 1)}…` : text;

const notFound = (what: string) => new StoreError('not_found', `${what} not found.`);

export interface RequestResult {
  requestId: string;
  itemId: string;
  status: 'waiting for approval' | 'done' | 'failed';
  // What a waiting request will create, so later requests can name it.
  forkId?: string;
  groupId?: string;
  resultId?: string | null;
  detail?: string | null;
  result?: unknown;
}

// The request store of a daemon: ceilings from the runner's last capabilities report. It keeps
// nothing in memory between calls, so the main port and the tools port may each have one.
export const requestStoreFor = (chats: ChatStore, runs: RunStore) =>
  new RequestStore(chats, () => runs.lastCapabilities()?.capabilities ?? null);

// What Claude asked to do, kept as cards for the user to approve. Approving runs the stored,
// edited version; Claude has no part in it after asking, and learns the outcome from the card's
// record on its next turn.
export class RequestStore {
  // What the last item run returned, for an autonomous run's result.
  private lastValue: unknown;

  constructor(
    private readonly chats: ChatStore,
    private readonly capabilities: () => RunnerCapabilities | null = () => null,
  ) {}

  private get db() {
    return this.chats.database;
  }

  private now() {
    return this.chats.clock();
  }

  get(requestId: string): ActionRequest {
    return toActionRequest(this.requireRow(requestId));
  }

  list(explorationId: string): ActionRequest[] {
    return this.db
      .all<ActionRequestRow>(
        'SELECT * FROM action_requests WHERE exploration_id = ? ORDER BY created_at, rowid',
        explorationId,
      )
      .map(toActionRequest);
  }

  // Adds an action to the card Claude is filling in this turn, or starts a new card. Nothing runs.
  request(forkId: string, requestedBy: RequestOrigin, action: RequestAction): RequestResult {
    const fork = this.chats.fork(forkId);
    this.validate(fork.explorationId, forkId, action);
    if (this.isAutonomous(fork, action)) return this.runAutonomously(fork, requestedBy, action);
    const item: RequestItem = {
      id: newId(),
      original: action,
      final: null,
      outcome: null,
      detail: null,
      resultId: null,
    };
    const now = this.now();
    const request = this.db.transaction(() => {
      const open = this.db.get<ActionRequestRow>(
        `SELECT * FROM action_requests
         WHERE fork_id = ? AND status = 'waiting' AND requested_by = ? AND after_message_id IS ?
         ORDER BY created_at DESC, rowid DESC LIMIT 1`,
        forkId,
        requestedBy,
        fork.tipMessageId,
      );
      if (open) {
        const items = [...(JSON.parse(open.items) as RequestItem[]), item];
        this.db.run(
          'UPDATE action_requests SET items = ?, updated_at = ? WHERE id = ?',
          JSON.stringify(items),
          now,
          open.id,
        );
        this.promise(fork.explorationId, open.id, item);
        return { id: open.id, created: false };
      }
      const id = `${requestIdPrefix}${newId()}`;
      this.db.run(
        `INSERT INTO action_requests (id, exploration_id, fork_id, after_message_id, requested_by,
           items, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        id,
        fork.explorationId,
        forkId,
        fork.tipMessageId,
        requestedBy,
        JSON.stringify([item]),
        now,
        now,
      );
      this.promise(fork.explorationId, id, item);
      return { id, created: true };
    });
    const saved = this.get(request.id);
    this.chats.eventBus.publish(saved.explorationId, {
      type: request.created ? 'request.created' : 'request.updated',
      request: saved,
    });
    const made = createdBy(action);
    return {
      requestId: request.id,
      itemId: item.id,
      status: 'waiting for approval',
      ...(made?.kind === 'fork' && { forkId: made.id }),
      ...(made?.kind === 'group' && { groupId: made.id }),
    };
  }

  // The fork's Autonomous setting covers the action's area, and new forks are under the hourly cap.
  private isAutonomous(fork: Fork, action: RequestAction) {
    const area = autonomousAreaOf(action);
    if (!area || !fork.autonomous.includes(area)) return false;
    if (area !== 'forks') return true;
    const cap = this.capabilities()?.autonomousForksPerHour ?? defaultAutonomousForksPerHour;
    return this.autonomousForksSince(fork.explorationId, this.now() - hourMs) < cap;
  }

  private autonomousForksSince(explorationId: string, since: number) {
    return this.db
      .all<ActionRequestRow>(
        `SELECT * FROM action_requests
         WHERE exploration_id = ? AND decided_by = 'autonomous' AND decided_at >= ?`,
        explorationId,
        since,
      )
      .flatMap((row) => JSON.parse(row.items) as RequestItem[])
      .filter((item) => item.original.kind === 'fork' && item.outcome === 'done').length;
  }

  // Runs at once, logged as a request the autonomous setting decided. Claude hears the outcome in
  // the tool's result, so it counts as reported.
  private runAutonomously(fork: Fork, requestedBy: RequestOrigin, action: RequestAction) {
    const now = this.now();
    const id = `${requestIdPrefix}${newId()}`;
    const item: RequestItem = {
      id: newId(),
      original: action,
      final: null,
      outcome: null,
      detail: null,
      resultId: null,
    };
    this.db.run(
      `INSERT INTO action_requests (id, exploration_id, fork_id, after_message_id, requested_by,
         items, reported_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      fork.explorationId,
      fork.id,
      fork.tipMessageId,
      requestedBy,
      JSON.stringify([item]),
      now,
      now,
      now,
    );
    this.promise(fork.explorationId, id, item);
    this.lastValue = undefined;
    const [decided] = this.run(this.requireRow(id), [{ item, final: action, selected: true }]);
    this.save(id, [decided!], { status: 'approved', decidedBy: 'autonomous', reason: null, now });
    const saved = this.get(id);
    this.chats.eventBus.publish(saved.explorationId, { type: 'request.created', request: saved });
    return {
      requestId: id,
      itemId: item.id,
      status: decided!.outcome === 'done' ? ('done' as const) : ('failed' as const),
      resultId: decided!.resultId,
      detail: decided!.detail,
      // What the store answered, as the tool gave it before it became a request.
      ...(decided!.outcome === 'done' && { result: this.lastValue }),
    };
  }

  // The user's decision. Approving runs the ticked items in order, with the user's edits; an item
  // aimed at a fork or group another item was to create runs only once that one did.
  decide(requestId: string, decision: RequestDecision): ActionRequest {
    const row = this.requireRow(requestId);
    if (row.status !== 'waiting') {
      throw new StoreError('already_decided', `Request ${requestId} was already decided.`);
    }
    const items = JSON.parse(row.items) as RequestItem[];
    const choices = new Map((decision.items ?? []).map((choice) => [choice.id, choice]));
    for (const id of choices.keys()) {
      if (!items.some((item) => item.id === id)) {
        throw new StoreError('invalid', `Request ${requestId} has no item ${id}.`);
      }
    }
    const now = this.now();
    if (decision.decision === 'reject') {
      const rejected = items.map((item) => ({ ...item, outcome: 'rejected' as const }));
      this.save(row.id, rejected, {
        status: 'rejected',
        decidedBy: 'user',
        reason: decision.reason?.trim() || null,
        now,
      });
      return this.publishUpdate(row.id);
    }
    // Edits are checked before anything runs, so a bad edit changes nothing.
    const planned = items.map((item) => {
      const choice = choices.get(item.id);
      const final = choice?.action ?? item.original;
      this.checkEdit(item.original, final);
      return { item, final, selected: choice?.selected ?? true };
    });
    if (!planned.some((entry) => entry.selected)) {
      throw new StoreError('invalid', 'Tick at least one item to approve, or reject the request.');
    }
    const decided = this.run(row, planned);
    this.save(row.id, decided, { status: 'approved', decidedBy: 'user', reason: null, now });
    return this.publishUpdate(row.id);
  }

  // Requests decided since Claude last heard, as one block to put before its next message; null
  // when there are none. They count as heard from then on.
  takeOutcomes(forkId: string): string | null {
    const rows = this.db.all<ActionRequestRow>(
      `SELECT * FROM action_requests
       WHERE fork_id = ? AND status != 'waiting' AND reported_at IS NULL
       ORDER BY decided_at, rowid`,
      forkId,
    );
    if (rows.length === 0) return null;
    const now = this.now();
    for (const row of rows) {
      this.db.run('UPDATE action_requests SET reported_at = ? WHERE id = ?', now, row.id);
    }
    return [
      'The user decided on your requests:',
      ...rows.map((row) => outcomeText(toActionRequest(row))),
    ].join('\n');
  }

  // A new session's history has every decided request, so none is left to report.
  markReported(forkId: string) {
    this.db.run(
      `UPDATE action_requests SET reported_at = ?
       WHERE fork_id = ? AND status != 'waiting' AND reported_at IS NULL`,
      this.now(),
      forkId,
    );
  }

  // The fork's requests as Claude sees them in a new session's history, after their message.
  historyRecords(forkId: string): { afterMessageId: string | null; text: string }[] {
    return this.db
      .all<ActionRequestRow>(
        'SELECT * FROM action_requests WHERE fork_id = ? ORDER BY created_at, rowid',
        forkId,
      )
      .map((row) => ({
        afterMessageId: row.after_message_id,
        text: outcomeText(toActionRequest(row)),
      }));
  }

  private run(
    row: ActionRequestRow,
    planned: { item: RequestItem; final: RequestAction; selected: boolean }[],
  ) {
    const done = new Set<string>();
    return planned.map(({ item, final, selected }): RequestItem => {
      const decided = { ...item, final };
      if (!selected) return { ...decided, outcome: 'unticked' };
      const blocked = this.blockedBy(row, final, done);
      if (blocked) return { ...decided, outcome: 'skipped', detail: blocked };
      try {
        const { resultId, value } = this.execute(row, final);
        this.lastValue = value;
        const made = createdBy(final);
        if (made) done.add(made.id);
        return { ...decided, outcome: 'done', resultId };
      } catch (error) {
        if (!(error instanceof StoreError)) throw error;
        return { ...decided, outcome: 'failed', detail: error.message };
      }
    });
  }

  // An item aimed at a fork or group that doesn't exist, which an item of a request was to create
  // and didn't, is not run.
  private blockedBy(row: ActionRequestRow, action: RequestAction, done: Set<string>) {
    const target = targetOf(action);
    if (!target || done.has(target.id) || this.exists(row.exploration_id, target)) return null;
    if (!this.isReserved(row.exploration_id, target.id)) return null;
    return target.kind === 'fork'
      ? "Not run: its fork wasn't created."
      : "Not run: its note group wasn't created.";
  }

  // Runs an action; what it made, and what the store answered, for an autonomous run's result.
  private execute(
    row: ActionRequestRow,
    action: RequestAction,
  ): { resultId: string | null; value: unknown } {
    const explorationId = row.exploration_id;
    const chats = this.chats;
    switch (action.kind) {
      case 'fork': {
        this.checkCeilings(action);
        const fork = chats.startRequestedFork({
          forkId: action.forkId,
          parentForkId: row.fork_id,
          title: action.title,
          brief: action.brief,
          awareness: action.awareness,
          coding: action.coding,
          model: action.model,
          network: {
            hosts: action.hosts,
            registries: action.registries,
            credentials: action.credentials,
          },
        });
        return { resultId: fork.id, value: { forkId: fork.id } };
      }
      case 'message': {
        this.requireFork(explorationId, action.forkId);
        const message = chats.addSupervisorMessage(action.forkId, action.text);
        return { resultId: message.id, value: { messageId: message.id } };
      }
      case 'fork_settings': {
        const fork = this.requireFork(explorationId, action.forkId);
        const { title, awareness, coding, model, hosts, registries, credentials } = action.changes;
        this.checkCeilings({ coding, hosts, credentials });
        if (title !== undefined) chats.updateForkSummary({ forkId: fork.id, summary: title });
        if (awareness !== undefined) chats.setForkAwareness(fork.id, awareness);
        if (coding !== undefined) chats.setForkCoding(fork.id, coding);
        if (model !== undefined) chats.setForkModel(fork.id, model);
        if (hosts !== undefined || registries !== undefined || credentials !== undefined) {
          const network = chats.fork(fork.id).network;
          chats.setForkNetwork(fork.id, {
            hosts: hosts ?? network.hosts,
            registries: registries ?? network.registries,
            credentials: credentials ?? network.credentials,
          });
        }
        return { resultId: fork.id, value: chats.fork(fork.id) };
      }
      case 'note_group': {
        const group = chats.createNoteGroup(explorationId, {
          id: action.groupId,
          name: action.name,
          checklist: action.checklist,
        });
        return { resultId: group.id, value: group };
      }
      case 'notes': {
        const added = chats.addNotes({
          explorationId,
          groupId: action.groupId,
          notes: action.notes,
          sourceMessageId: action.sourceMessageId ?? undefined,
        });
        return { resultId: added.noteIds[0] ?? null, value: added };
      }
      case 'note_update': {
        this.requireNote(explorationId, action.noteId);
        const { kind: _kind, noteId, ...changes } = action;
        const defined = Object.fromEntries(
          Object.entries(changes).filter(([, value]) => value !== undefined),
        );
        const note = chats.updateNote(noteId, defined, 'claude');
        return { resultId: note.id, value: note };
      }
      case 'note_group_change': {
        this.requireNote(explorationId, action.noteId);
        this.requireGroup(explorationId, action.groupId);
        return {
          resultId: action.noteId,
          value: chats.changeNoteGroup(action.noteId, action.groupId),
        };
      }
      case 'note_category':
        this.requireGroup(explorationId, action.groupId);
        return {
          resultId: action.groupId,
          value: chats.renameNoteCategory(action.groupId, action.from, action.to),
        };
      case 'note_deletion':
        this.requireNote(explorationId, action.noteId);
        chats.deleteNote(action.noteId);
        return { resultId: null, value: { deleted: action.noteId } };
      case 'board':
        return {
          resultId: action.input.forkId ?? null,
          value: chats.arrangeBoard(explorationId, action.input),
        };
    }
  }

  // What Claude may ask for: things of its own chat, or that a waiting request will create.
  private validate(explorationId: string, requesterForkId: string, action: RequestAction) {
    const target = targetOf(action);
    if (
      target &&
      !this.exists(explorationId, target) &&
      !this.isReserved(explorationId, target.id)
    ) {
      throw notFound(`${target.kind === 'fork' ? 'Fork' : 'Note group'} ${target.id}`);
    }
    switch (action.kind) {
      case 'fork':
        if (!action.brief.trim()) throw new StoreError('invalid', 'The new fork needs a brief.');
        if (this.chats.fork(requesterForkId).tipMessageId === null) {
          throw new StoreError('invalid', 'This fork has no messages to fork from yet.');
        }
        this.checkCeilings(action);
        break;
      case 'message':
        if (action.forkId === requesterForkId) {
          throw new StoreError('invalid', 'Messages go to another fork; answer in this one.');
        }
        if (!action.text.trim()) throw new StoreError('invalid', 'Write a message for the fork.');
        break;
      case 'fork_settings': {
        const { changes } = action;
        if (Object.values(changes).every((value) => value === undefined)) {
          throw new StoreError('invalid', 'Name at least one setting to change.');
        }
        if (changes.title !== undefined && !changes.title.trim()) {
          throw new StoreError('invalid', 'A fork title cannot be empty.');
        }
        this.checkCeilings(changes);
        break;
      }
      case 'notes':
        if (action.notes.length === 0) throw new StoreError('invalid', 'Add at least one note.');
        if (action.notes.some((note) => !note.topic?.trim() && !note.description?.trim())) {
          throw new StoreError('invalid', 'Every note needs a topic or a description.');
        }
        break;
      case 'note_update':
      case 'note_group_change':
      case 'note_deletion':
        this.requireNote(explorationId, action.noteId);
        break;
      default:
        break;
    }
  }

  // The user may change values, not what the item is or the ids picked for what it creates.
  private checkEdit(original: RequestAction, final: RequestAction) {
    if (final.kind !== original.kind) {
      throw new StoreError('invalid', 'An edit cannot change what kind of action an item is.');
    }
    const made = createdBy(original);
    if (made && createdBy(final)?.id !== made.id) {
      throw new StoreError('invalid', 'An edit cannot change the id of what an item creates.');
    }
    if (final.kind === 'fork' && !final.brief.trim()) {
      throw new StoreError('invalid', 'The new fork needs a brief.');
    }
  }

  // The runner's ceilings, from its last report: the runner checks every job again anyway.
  private checkCeilings(values: {
    coding?: boolean | undefined;
    hosts?: string[] | undefined;
    credentials?: string[] | undefined;
  }) {
    const hosts = values.hosts ?? [];
    if (hosts.length > maxAllowedHosts) {
      throw new StoreError('invalid', `A fork allows at most ${maxAllowedHosts} hosts.`);
    }
    for (const host of hosts) {
      if (!isHostPort(host)) {
        throw new StoreError('invalid', `${host} is not a host:port, such as github.com:443.`);
      }
    }
    const capabilities = this.capabilities();
    if (!capabilities) return;
    if (values.coding && !capabilities.coding) {
      throw new StoreError(
        'invalid',
        `Coding is off on this runner${capabilities.codingOff ? `: ${capabilities.codingOff}` : '.'}`,
      );
    }
    const allowed = capabilities.allowedHosts;
    for (const host of hosts) {
      if (allowed && !allowed.some((pattern) => matchesHostPattern(pattern, host))) {
        throw new StoreError('invalid', `${host} is beyond the hosts the runner allows.`);
      }
    }
    const names = new Set(capabilities.credentials.map((credential) => credential.name));
    for (const name of values.credentials ?? []) {
      if (!names.has(name)) {
        throw new StoreError('invalid', `The runner has no credential named ${name}.`);
      }
    }
  }

  private exists(explorationId: string, target: { kind: 'fork' | 'group'; id: string }) {
    const table = target.kind === 'fork' ? 'forks' : 'note_groups';
    return (
      this.db.get(
        `SELECT 1 FROM ${table} WHERE id = ? AND exploration_id = ?`,
        target.id,
        explorationId,
      ) !== undefined
    );
  }

  // Records the id of the fork or group an item will create, so later requests may name it.
  private promise(explorationId: string, requestId: string, item: RequestItem) {
    const made = createdBy(item.original);
    if (!made) return;
    this.db.run(
      `INSERT INTO request_promises (id, exploration_id, kind, request_id, item_id)
       VALUES (?, ?, ?, ?, ?)`,
      made.id,
      explorationId,
      made.kind,
      requestId,
      item.id,
    );
  }

  // An id a request of this chat picked for a fork or group it creates: one lookup by key.
  private isReserved(explorationId: string, id: string) {
    return (
      this.db.get(
        'SELECT 1 FROM request_promises WHERE id = ? AND exploration_id = ?',
        id,
        explorationId,
      ) !== undefined
    );
  }

  private requireFork(explorationId: string, forkId: string) {
    if (!this.exists(explorationId, { kind: 'fork', id: forkId })) throw notFound(`Fork ${forkId}`);
    return this.chats.fork(forkId);
  }

  private requireGroup(explorationId: string, groupId: string) {
    if (!this.exists(explorationId, { kind: 'group', id: groupId })) {
      throw notFound(`Note group ${groupId}`);
    }
  }

  private requireNote(explorationId: string, noteId: string) {
    const found = this.db.get(
      'SELECT 1 FROM notes WHERE id = ? AND exploration_id = ?',
      noteId,
      explorationId,
    );
    if (!found) throw notFound(`Note ${noteId}`);
  }

  private save(
    requestId: string,
    items: RequestItem[],
    decision: {
      status: 'approved' | 'rejected';
      decidedBy: 'user' | 'autonomous';
      reason: string | null;
      now: number;
    },
  ) {
    this.db.run(
      `UPDATE action_requests SET items = ?, status = ?, decided_by = ?, decided_at = ?, reason = ?,
         updated_at = ? WHERE id = ?`,
      JSON.stringify(items),
      decision.status,
      decision.decidedBy,
      decision.now,
      decision.reason,
      decision.now,
      requestId,
    );
  }

  private publishUpdate(requestId: string) {
    const request = this.get(requestId);
    this.chats.eventBus.publish(request.explorationId, { type: 'request.updated', request });
    return request;
  }

  private requireRow(requestId: string) {
    const row = this.db.get<ActionRequestRow>(
      'SELECT * FROM action_requests WHERE id = ?',
      requestId,
    );
    if (!row) throw notFound(`Request ${requestId}`);
    return row;
  }
}

const outcomeLabels = {
  done: 'done',
  failed: 'failed',
  skipped: 'not run',
  unticked: 'not requested (unticked)',
  rejected: 'rejected',
} as const;

// A short record of a request and how it was decided, for Claude.
export function outcomeText(request: ActionRequest): string {
  const decided =
    request.status === 'waiting'
      ? 'waiting for the user'
      : `${request.status} by ${request.decidedBy === 'autonomous' ? 'the autonomous setting' : 'the user'}`;
  const lines = [
    `- Request ${request.id}, ${decided}${request.reason ? `. Reason: ${cut(request.reason)}` : ''}:`,
  ];
  for (const item of request.items) {
    const action = item.final ?? item.original;
    const outcome = item.outcome ? outcomeLabels[item.outcome] : 'waiting';
    const parts = [`  - ${describeAction(action)}: ${outcome}`];
    if (item.resultId && item.outcome === 'done') parts.push(` (${item.resultId})`);
    if (item.detail) parts.push(`. ${item.detail}`);
    const edited = editedFields(item.original, item.final);
    if (edited.length > 0) {
      const values = edited.map(
        (field) => `${field}: ${cut(JSON.stringify(fieldValue(action, field)))}`,
      );
      parts.push(`. The user edited it; now ${values.join('; ')}`);
    }
    lines.push(parts.join(''));
  }
  return lines.join('\n');
}

function fieldValue(action: RequestAction, field: string): unknown {
  if (action.kind === 'fork_settings') return (action.changes as Record<string, unknown>)[field];
  if (action.kind === 'board') return (action.input as unknown as Record<string, unknown>)[field];
  return (action as unknown as Record<string, unknown>)[field];
}
