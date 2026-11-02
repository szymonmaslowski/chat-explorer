import { idAlphabet, idLength } from '@shared/ids';
import type {
  CommentChanges,
  MessageFile,
  NewComment,
  NewNote,
  NewNoteGroup,
  NoteChanges,
  NoteGroupChanges,
} from '@shared/types';
import { computed, reactive, ref } from 'vue';
import { api, ApiError } from '../api';

export interface ReplyDraftChange {
  text: string;
  newFork: boolean;
  fileIds: string[];
}

export interface SubmissionChange {
  id: string;
  forkId: string;
  globalMessage: string;
  newFork: boolean;
  files: MessageFile[];
}

export type Change =
  | { type: 'comment.create'; explorationId: string; comment: NewComment & { id: string } }
  | { type: 'comment.update'; explorationId: string; commentId: string; changes: CommentChanges }
  | { type: 'comment.delete'; explorationId: string; commentId: string }
  | { type: 'reply-draft.save'; explorationId: string; forkId: string; draft: ReplyDraftChange }
  | { type: 'submit'; explorationId: string; submission: SubmissionChange }
  | {
      type: 'fork-now';
      explorationId: string;
      submissionId: string;
      forkId: string;
      commentId: string;
    }
  | { type: 'submission.cancel'; explorationId: string; submissionId: string }
  | { type: 'note-group.create'; explorationId: string; group: NewNoteGroup & { id: string } }
  | {
      type: 'note-group.update';
      explorationId: string;
      groupId: string;
      changes: NoteGroupChanges;
    }
  | { type: 'note-group.delete'; explorationId: string; groupId: string }
  | { type: 'note.create'; explorationId: string; note: NewNote & { id: string } }
  | { type: 'note.update'; explorationId: string; noteId: string; changes: NoteChanges }
  | { type: 'note.delete'; explorationId: string; noteId: string }
  | { type: 'note.reorder'; explorationId: string; noteId: string; afterNoteId: string | null }
  | { type: 'note.change-group'; explorationId: string; noteId: string; groupId: string };

interface QueuedChange {
  key: number;
  change: Change;
}

interface StoredOutbox {
  nextKey: number;
  // The change a tab is sending now; the others leave it alone.
  sendingKey: number | null;
  queue: QueuedChange[];
}

export interface Failure {
  key: number;
  explorationId: string;
  message: string;
}

const storageKey = 'chat-explorer.outbox';
const lockName = 'chat-explorer-outbox';
const firstRetryMs = 1_000;
const maxRetryMs = 30_000;
// A proxy answers these while the daemon restarts; the change is sent again later.
const unavailableStatuses = new Set([502, 503, 504]);

export function newId() {
  return [...crypto.getRandomValues(new Uint8Array(idLength))]
    .map((byte) => idAlphabet[byte % idAlphabet.length])
    .join('');
}

// Changes are kept in the browser until the daemon has them, so they survive a lost connection
// and a page the phone unloads meanwhile, and are sent in the order they were made. Every tab
// shares the one queue; a Web Lock lets one tab at a time send it.
function readStored(): StoredOutbox {
  try {
    const stored = localStorage.getItem(storageKey);
    if (stored) return JSON.parse(stored);
  } catch {}
  return { nextKey: 0, sendingKey: null, queue: [] };
}

function writeStored(stored: StoredOutbox) {
  try {
    localStorage.setItem(storageKey, JSON.stringify(stored));
  } catch {}
  queue.value = stored.queue;
}

const queue = ref<QueuedChange[]>(readStored().queue);
const stalled = ref(false);
const failures = reactive<Failure[]>([]);
const changeListeners = new Set<(change: Change) => void>();
const failureListeners = new Set<(explorationId: string) => void>();
let retryMs = firstRetryMs;
let retryTimer: ReturnType<typeof setTimeout> | undefined;
let flushing: Promise<void> | null = null;

export const subjectOf = (change: Change) => {
  switch (change.type) {
    case 'comment.create':
      return change.comment.id;
    case 'comment.update':
    case 'comment.delete':
      return change.commentId;
    case 'reply-draft.save':
      return change.forkId;
    case 'submit':
      return change.submission.id;
    case 'fork-now':
    case 'submission.cancel':
      return change.submissionId;
    case 'note-group.create':
      return change.group.id;
    case 'note-group.update':
    case 'note-group.delete':
      return change.groupId;
    case 'note.create':
      return change.note.id;
    case 'note.update':
    case 'note.delete':
    case 'note.reorder':
    case 'note.change-group':
      return change.noteId;
  }
};

// Typing saves every second, so a change to the same thing as the last unsent one replaces it.
function merge(waiting: Change, next: Change): Change | null {
  if (subjectOf(waiting) !== subjectOf(next)) return null;
  if (waiting.type === 'comment.update' && next.type === 'comment.update') {
    return { ...next, changes: { ...waiting.changes, ...next.changes } };
  }
  if (waiting.type === 'comment.create' && next.type === 'comment.update') {
    const { editBody, ...rest } = { ...waiting.comment, ...next.changes };
    return { ...waiting, comment: editBody === null ? rest : { ...rest, editBody } };
  }
  if (waiting.type === 'reply-draft.save' && next.type === 'reply-draft.save') return next;
  if (waiting.type === 'note.update' && next.type === 'note.update') {
    return { ...next, changes: { ...waiting.changes, ...next.changes } };
  }
  if (waiting.type === 'note.reorder' && next.type === 'note.reorder') return next;
  if (waiting.type === 'note-group.update' && next.type === 'note-group.update') {
    return { ...next, changes: { ...waiting.changes, ...next.changes } };
  }
  return null;
}

// Deleting a comment or a note, or cancelling a submission, the daemon never got needs no request
// at all.
function withdraw(stored: StoredOutbox, change: Change) {
  const created: Change['type'][] =
    change.type === 'comment.delete'
      ? ['comment.create']
      : change.type === 'note.delete'
        ? ['note.create']
        : change.type === 'submission.cancel'
          ? ['submit', 'fork-now']
          : [];
  const subject = subjectOf(change);
  const creation = stored.queue.find(
    (queued) => created.includes(queued.change.type) && subjectOf(queued.change) === subject,
  );
  if (!creation || creation.key === stored.sendingKey) return false;
  stored.queue = stored.queue.filter(
    (queued) => subjectOf(queued.change) !== subject || queued.key === stored.sendingKey,
  );
  return true;
}

function add(change: Change) {
  const stored = readStored();
  const last = stored.queue.at(-1);
  const merged = last && last.key !== stored.sendingKey ? merge(last.change, change) : null;
  if (merged) last!.change = merged;
  else if (!withdraw(stored, change)) stored.queue.push({ key: stored.nextKey++, change });
  writeStored(stored);
  for (const listener of changeListeners) listener(change);
  void flush();
}

function send(change: Change) {
  const keepalive = document.visibilityState === 'hidden';
  switch (change.type) {
    case 'comment.create':
      return api.createComment(change.explorationId, change.comment, keepalive);
    case 'comment.update':
      return api.updateComment(change.commentId, change.changes, keepalive);
    case 'comment.delete':
      return api.deleteComment(change.commentId, keepalive);
    case 'reply-draft.save':
      return api.saveReplyDraft(change.forkId, change.draft, keepalive);
    case 'submit': {
      const { id, forkId, globalMessage, newFork, files } = change.submission;
      const fileIds = files.map((file) => file.id);
      return api.submit(
        change.explorationId,
        forkId,
        globalMessage,
        { id, newFork, fileIds },
        keepalive,
      );
    }
    case 'fork-now':
      return api.forkNow(change.commentId, change.submissionId, keepalive);
    case 'submission.cancel':
      return api.cancelSubmission(change.submissionId, keepalive);
    case 'note-group.create':
      return api.createNoteGroup(change.explorationId, change.group, keepalive);
    case 'note-group.update':
      return api.updateNoteGroup(change.groupId, change.changes, keepalive);
    case 'note-group.delete':
      return api.deleteNoteGroup(change.groupId, keepalive);
    case 'note.create':
      return api.createNote(change.explorationId, change.note, keepalive);
    case 'note.update':
      return api.updateNote(change.noteId, change.changes, keepalive);
    case 'note.delete':
      return api.deleteNote(change.noteId, keepalive);
    case 'note.reorder':
      return api.reorderNote(change.noteId, change.afterNoteId, keepalive);
    case 'note.change-group':
      return api.changeNoteGroup(change.noteId, change.groupId, keepalive);
  }
}

const isUnreachable = (error: unknown) =>
  !(error instanceof ApiError) || unavailableStatuses.has(error.status);

// What a repeated delete or cancel finds once the first one went through.
const alreadyDone = (change: Change, error: unknown) =>
  (change.type === 'comment.delete' ||
    change.type === 'note.delete' ||
    change.type === 'note-group.delete' ||
    change.type === 'submission.cancel') &&
  error instanceof ApiError &&
  error.code === 'not_found';

function failureMessage(change: Change, error: unknown) {
  const reason = error instanceof Error ? error.message : 'The daemon refused it.';
  if (change.type === 'submission.cancel' && error instanceof ApiError) {
    if (error.code === 'already_sent') return 'Could not cancel: already sent to Claude.';
  }
  return change.type === 'submit' || change.type === 'fork-now'
    ? `Could not send: ${reason}`
    : `Could not save: ${reason}`;
}

function remove(key: number) {
  const stored = readStored();
  stored.queue = stored.queue.filter((queued) => queued.key !== key);
  stored.sendingKey = null;
  writeStored(stored);
}

async function sendAll() {
  for (;;) {
    const stored = readStored();
    const head = stored.queue[0];
    if (!head) return true;
    stored.sendingKey = head.key;
    writeStored(stored);
    try {
      await send(head.change);
    } catch (error) {
      if (isUnreachable(error)) {
        const unsent = readStored();
        unsent.sendingKey = null;
        writeStored(unsent);
        return false;
      }
      if (!alreadyDone(head.change, error)) {
        failures.push({
          key: head.key,
          explorationId: head.change.explorationId,
          message: failureMessage(head.change, error),
        });
        for (const listener of failureListeners) listener(head.change.explorationId);
      }
    }
    remove(head.key);
  }
}

// Resolves once everything is sent, or as soon as the daemon cannot be reached.
function flush(): Promise<void> {
  clearTimeout(retryTimer);
  if (flushing) return flushing;
  flushing = (async () => {
    const sent = navigator.locks
      ? await navigator.locks.request(lockName, sendAll)
      : await sendAll();
    stalled.value = !sent;
    if (sent) {
      retryMs = firstRetryMs;
      return;
    }
    retryTimer = setTimeout(() => void flush(), retryMs);
    retryMs = Math.min(retryMs * 2, maxRetryMs);
  })().finally(() => {
    flushing = null;
    // A change added while this pass was ending would otherwise wait for the next one.
    if (!stalled.value && readStored().queue.length > 0) void flush();
  });
  return flushing;
}

window.addEventListener('online', () => void flush());
window.addEventListener('storage', (event) => {
  if (event.key === storageKey) queue.value = readStored().queue;
});
if (queue.value.length > 0) void flush();

const pendingSubjects = computed(
  () => new Set(queue.value.map((queued) => subjectOf(queued.change))),
);

export const outbox = {
  add,
  flush,
  // Changes not sent yet, oldest first.
  changes: computed(() => queue.value.map((queued) => queued.change)),
  // True while the daemon cannot be reached and changes wait for it.
  stalled: computed(() => stalled.value && queue.value.length > 0),
  failures,
  isPending: (subject: string) => pendingSubjects.value.has(subject),
  dismissFailure: (key: number) => {
    const index = failures.findIndex((failure) => failure.key === key);
    if (index !== -1) failures.splice(index, 1);
  },
  onChange: (listener: (change: Change) => void) => changeListeners.add(listener),
  onFailure: (listener: (explorationId: string) => void) => failureListeners.add(listener),
};
