import type {
  Bookmark,
  Comment,
  Exploration,
  ExplorationEvent,
  Fork,
  Message,
  MessageFile,
  Note,
  NoteGroup,
  QueuedSubmission,
  ReplyDraft,
  SessionStatus,
  Snapshot,
} from '@shared/types';
import { joinForkGroup, leaveForkGroup } from '@shared/fork-groups';
import { defaultGroupName, noteForkMessage, reorderedIds } from '@shared/notes';
import { nextTick, reactive, watch } from 'vue';
import { api, ApiError } from '../api';
import { openEventStream } from '../lib/event-stream';
import { applyNoteOrder, notesInGroup, renumberGroup } from '../lib/notes';
import { outbox, subjectOf, type Change } from './outbox';

export interface ExplorationState {
  explorationId: string;
  status: 'loading' | 'ready' | 'missing' | 'deleted' | 'error';
  exploration: Exploration | null;
  forks: Map<string, Fork>;
  messages: Map<string, Message>;
  comments: Map<string, Comment>;
  queuedSubmissions: Map<string, QueuedSubmission>;
  files: Map<string, MessageFile>;
  // As loaded; the reply box takes over from there and saves its own changes.
  replyDrafts: Map<string, ReplyDraft>;
  noteGroups: Map<string, NoteGroup>;
  notes: Map<string, Note>;
  bookmarks: Map<string, Bookmark>;
  sessionStatus: SessionStatus;
  sessionError: string | null;
  connected: boolean;
}

const eventTypes: ExplorationEvent['type'][] = [
  'message.added',
  'messages.read',
  'fork.created',
  'fork.updated',
  'comment.created',
  'comment.updated',
  'comment.deleted',
  'submission.queued',
  'submission.cancelled',
  'submission.delivered',
  'files.updated',
  'files.released',
  'note-group.created',
  'note-group.updated',
  'note-group.deleted',
  'note.created',
  'note.updated',
  'note.deleted',
  'notes.reordered',
  'note.group-changed',
  'bookmark.created',
  'bookmark.deleted',
  'exploration.updated',
  'exploration.deleted',
  'session.status',
  'session.error',
];

const byId = <Item extends { id: string }>(items: Item[]) =>
  new Map(items.map((item) => [item.id, item]));

export function applyReadChange(
  state: ExplorationState,
  messageIds: string[],
  readAt: number | null,
) {
  for (const messageId of messageIds) {
    const message = state.messages.get(messageId);
    if (message) message.readAt = readAt;
  }
}

export function applyEvent(state: ExplorationState, event: ExplorationEvent) {
  switch (event.type) {
    case 'message.added':
      state.messages.set(event.message.id, event.message);
      state.forks.set(event.fork.id, event.fork);
      break;
    case 'messages.read':
      applyReadChange(state, event.messageIds, event.readAt);
      break;
    case 'fork.created':
    case 'fork.updated':
      state.forks.set(event.fork.id, event.fork);
      break;
    case 'comment.created':
    case 'comment.updated':
      state.comments.set(event.comment.id, event.comment);
      break;
    case 'comment.deleted':
      state.comments.delete(event.commentId);
      break;
    case 'submission.queued':
      state.queuedSubmissions.set(event.submission.id, event.submission);
      break;
    case 'submission.cancelled':
    case 'submission.delivered':
      state.queuedSubmissions.delete(event.submissionId);
      break;
    case 'files.updated':
      for (const file of event.files) state.files.set(file.id, file);
      break;
    case 'files.released':
      for (const fileId of event.fileIds) state.files.delete(fileId);
      break;
    case 'note-group.created':
    case 'note-group.updated':
      state.noteGroups.set(event.group.id, event.group);
      break;
    case 'note-group.deleted':
      deleteNoteGroup(state, event.groupId);
      break;
    case 'note.created':
    case 'note.updated':
      state.notes.set(event.note.id, event.note);
      break;
    case 'note.deleted':
      state.notes.delete(event.noteId);
      break;
    case 'notes.reordered':
      applyNoteOrder(state.notes, event.noteIds);
      break;
    case 'note.group-changed':
      state.notes.set(event.note.id, event.note);
      applyNoteOrder(state.notes, event.noteIds);
      break;
    case 'bookmark.created':
      state.bookmarks.set(event.bookmark.id, event.bookmark);
      break;
    case 'bookmark.deleted':
      state.bookmarks.delete(event.bookmarkId);
      break;
    case 'exploration.updated':
      state.exploration = event.exploration;
      break;
    case 'exploration.deleted':
      state.status = 'deleted';
      break;
    case 'session.status':
      state.sessionStatus = event.status;
      break;
    case 'session.error':
      state.sessionError = event.message;
      break;
    case 'session.attached':
      break;
  }
}

function deleteNoteGroup(state: ExplorationState, groupId: string) {
  state.noteGroups.delete(groupId);
  for (const note of state.notes.values()) {
    if (note.groupId === groupId) state.notes.delete(note.id);
  }
}

const eventSubjects = (event: ExplorationEvent) => {
  switch (event.type) {
    case 'comment.created':
    case 'comment.updated':
      return [event.comment.id];
    case 'note-group.created':
    case 'note-group.updated':
      return [event.group.id];
    case 'note.created':
    case 'note.updated':
      return [event.note.id];
    case 'note.group-changed':
      return [event.note.id, ...event.noteIds];
    case 'notes.reordered':
      return event.noteIds;
    default:
      return [];
  }
};

// The daemon's notice about a comment or a note can arrive after a later change to it was made
// here, such as "created, being written" after Save, or an order from before the last drag. The
// changes it has not confirmed yet go on top again, so the notice cannot undo them.
export function applyServerEvent(state: ExplorationState, event: ExplorationEvent) {
  applyEvent(state, event);
  const subjects = new Set(eventSubjects(event));
  if (subjects.size === 0) return;
  for (const change of outbox.changes.value) {
    if (subjects.has(subjectOf(change))) applyChange(state, change);
  }
}

// Notes do not go to Claude, so they stay out of fork groups.
const draftJoinableComments = (state: ExplorationState, viewForkId: string) =>
  [...state.comments.values()].filter(
    (comment) =>
      comment.viewForkId === viewForkId && comment.status === 'draft' && comment.type !== 'note',
  );

function setGroups(state: ExplorationState, changes: Map<string, string | null>) {
  for (const [commentId, forkGroupId] of changes) {
    const comment = state.comments.get(commentId);
    if (comment) state.comments.set(commentId, { ...comment, forkGroupId });
  }
}

function leaveGroup(state: ExplorationState, comment: Comment) {
  if (!comment.forkGroupId) return;
  setGroups(state, leaveForkGroup(draftJoinableComments(state, comment.viewForkId), comment.id));
}

// Shows a change before the daemon has it, as the daemon will once it does.
export function applyChange(state: ExplorationState, change: Change) {
  if (change.explorationId !== state.explorationId) return;
  const now = Date.now();
  switch (change.type) {
    case 'comment.create': {
      const { id, editBody, type, ...comment } = change.comment;
      const existing = state.comments.get(id);
      state.comments.set(id, {
        ...comment,
        id,
        explorationId: state.explorationId,
        editBody: editBody ?? null,
        type: type ?? 'inline',
        status: existing?.status ?? 'draft',
        submissionId: existing?.submissionId ?? null,
        replyMessageId: null,
        createdForkId: null,
        noteGroupId: change.comment.noteGroupId ?? existing?.noteGroupId ?? null,
        createdNoteId: null,
        forkGroupId: existing?.forkGroupId ?? null,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
      });
      break;
    }
    case 'comment.update': {
      const comment = state.comments.get(change.commentId);
      const { body, editBody, type, noteGroupId } = change.changes;
      if (!comment) break;
      if (type === 'note') leaveGroup(state, comment);
      state.comments.set(comment.id, {
        ...comment,
        body: body ?? comment.body,
        editBody: editBody === undefined ? comment.editBody : editBody,
        type: type ?? comment.type,
        noteGroupId: noteGroupId === undefined ? comment.noteGroupId : noteGroupId,
        updatedAt: now,
      });
      break;
    }
    case 'comment.delete': {
      const comment = state.comments.get(change.commentId);
      if (comment) leaveGroup(state, comment);
      state.comments.delete(change.commentId);
      break;
    }
    case 'comment.join-fork-group': {
      const start = state.comments.get(change.commentId);
      if (!start) break;
      const forkComments = draftJoinableComments(state, start.viewForkId);
      setGroups(
        state,
        joinForkGroup(forkComments, change.commentId, change.memberIds, change.groupId),
      );
      break;
    }
    case 'comment.leave-fork-group': {
      const comment = state.comments.get(change.commentId);
      if (comment) leaveGroup(state, comment);
      break;
    }
    case 'fork-group.ungroup':
      for (const comment of state.comments.values()) {
        if (comment.forkGroupId === change.groupId) {
          state.comments.set(comment.id, { ...comment, forkGroupId: null });
        }
      }
      break;
    case 'reply-draft.save':
      break;
    case 'submit': {
      const { id, forkId, globalMessage, newFork, files } = change.submission;
      const drafts = [...state.comments.values()].filter(
        (comment) => comment.viewForkId === forkId && comment.status === 'draft',
      );
      // Note comments become notes without Claude; they wait here only for the daemon.
      for (const comment of drafts) {
        const isNote = comment.type === 'note';
        state.comments.set(comment.id, {
          ...comment,
          status: 'queued',
          submissionId: isNote ? null : id,
        });
      }
      const forClaude =
        globalMessage.trim() !== '' ||
        files.length > 0 ||
        drafts.some((comment) => comment.type !== 'note');
      if (forClaude) {
        state.queuedSubmissions.set(id, {
          id,
          explorationId: state.explorationId,
          forkId,
          globalMessage: globalMessage.trim(),
          newFork,
          createdAt: now,
        });
      }
      for (const file of files) state.files.set(file.id, { ...file, submissionId: id });
      break;
    }
    case 'fork-now': {
      const { submissionId: id, forkId, commentId } = change;
      state.queuedSubmissions.set(id, {
        id,
        explorationId: state.explorationId,
        forkId,
        globalMessage: '',
        newFork: false,
        createdAt: now,
      });
      const comment = state.comments.get(commentId);
      if (!comment) break;
      // A comment in a group sends the whole group.
      const sent = comment.forkGroupId
        ? draftJoinableComments(state, comment.viewForkId).filter(
            (each) => each.forkGroupId === comment.forkGroupId,
          )
        : [comment];
      for (const each of sent) {
        state.comments.set(each.id, { ...each, status: 'queued', submissionId: id });
      }
      break;
    }
    case 'note.fork': {
      const { submissionId: id, forkId, parentForkId, baseMessageId, noteId, message } = change;
      if (!state.forks.has(forkId)) {
        state.forks.set(forkId, {
          id: forkId,
          explorationId: state.explorationId,
          parentForkId,
          baseMessageId,
          originCommentId: null,
          tipMessageId: null,
          kind: 'soft',
          summary: message.trim(),
          createdAt: now,
          updatedAt: now,
          archivedAt: null,
        });
      }
      const note = state.notes.get(noteId);
      state.queuedSubmissions.set(id, {
        id,
        explorationId: state.explorationId,
        forkId,
        globalMessage: note ? noteForkMessage(note, message) : message.trim(),
        newFork: false,
        createdAt: now,
      });
      break;
    }
    case 'submission.cancel':
      state.queuedSubmissions.delete(change.submissionId);
      for (const comment of state.comments.values()) {
        if (comment.submissionId === change.submissionId) {
          state.comments.set(comment.id, { ...comment, status: 'draft', submissionId: null });
        }
      }
      for (const file of state.files.values()) {
        if (file.submissionId === change.submissionId) state.files.delete(file.id);
      }
      break;
    case 'bookmark.create': {
      const existing = state.bookmarks.get(change.bookmark.id);
      state.bookmarks.set(change.bookmark.id, {
        ...change.bookmark,
        explorationId: state.explorationId,
        createdAt: existing?.createdAt ?? now,
      });
      break;
    }
    case 'bookmark.delete':
      state.bookmarks.delete(change.bookmarkId);
      break;
    case 'note-group.create': {
      const { id, name, checklist } = change.group;
      const existing = state.noteGroups.get(id);
      const others = [...state.noteGroups.values()].filter((group) => group.id !== id);
      state.noteGroups.set(id, {
        id,
        explorationId: state.explorationId,
        name: name?.trim() || defaultGroupName(others.map((group) => group.name)),
        checklist: checklist ?? false,
        position: existing?.position ?? Math.max(0, ...others.map((group) => group.position)) + 1,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
      });
      break;
    }
    case 'note-group.update': {
      const group = state.noteGroups.get(change.groupId);
      if (!group) break;
      const { name, checklist } = change.changes;
      const otherNames = [...state.noteGroups.values()]
        .filter((other) => other.id !== group.id)
        .map((other) => other.name);
      state.noteGroups.set(group.id, {
        ...group,
        name: name === undefined ? group.name : name.trim() || defaultGroupName(otherNames),
        checklist: checklist ?? group.checklist,
        updatedAt: now,
      });
      break;
    }
    case 'note-group.delete':
      deleteNoteGroup(state, change.groupId);
      break;
    case 'note.create': {
      const { id, groupId, topic, description } = change.note;
      const existing = state.notes.get(id);
      state.notes.set(id, {
        id,
        explorationId: state.explorationId,
        groupId,
        topic: topic?.trim() || null,
        description: description?.trim() ?? '',
        checked: existing?.checked ?? false,
        position: existing?.position ?? 0,
        sourceForkId: null,
        sourceMessageId: null,
        sourceQuote: null,
        sourceCommentId: null,
        createdBy: 'user',
        deletionRequestedAt: null,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
      });
      renumberGroup(state.notes, groupId);
      break;
    }
    case 'note.update': {
      const note = state.notes.get(change.noteId);
      if (!note) break;
      const { topic, description, checked } = change.changes;
      state.notes.set(note.id, {
        ...note,
        topic: topic === undefined ? note.topic : topic.trim() || null,
        description: description?.trim() ?? note.description,
        checked: checked ?? note.checked,
        updatedAt: now,
      });
      break;
    }
    case 'note.delete':
      state.notes.delete(change.noteId);
      break;
    case 'note.keep': {
      const note = state.notes.get(change.noteId);
      if (note) state.notes.set(note.id, { ...note, deletionRequestedAt: null, updatedAt: now });
      break;
    }
    case 'note.reorder': {
      const note = state.notes.get(change.noteId);
      if (!note) break;
      const noteIds = notesInGroup(state.notes, note.groupId).map((each) => each.id);
      applyNoteOrder(state.notes, reorderedIds(noteIds, note.id, change.afterNoteId));
      break;
    }
    case 'note.change-group': {
      const note = state.notes.get(change.noteId);
      if (!note || note.groupId === change.groupId) break;
      state.notes.set(note.id, { ...note, groupId: change.groupId, position: 0, updatedAt: now });
      renumberGroup(state.notes, note.groupId);
      renumberGroup(state.notes, change.groupId);
      break;
    }
  }
}

function applySnapshot(state: ExplorationState, snapshot: Snapshot) {
  state.exploration = snapshot.exploration;
  state.forks = byId(snapshot.forks);
  state.messages = byId(snapshot.messages);
  state.comments = byId(snapshot.comments);
  state.queuedSubmissions = byId(snapshot.queuedSubmissions);
  state.files = byId(snapshot.files);
  state.replyDrafts = new Map(snapshot.replyDrafts.map((draft) => [draft.forkId, draft]));
  state.noteGroups = byId(snapshot.noteGroups);
  state.notes = byId(snapshot.notes);
  state.bookmarks = byId(snapshot.bookmarks);
  state.sessionStatus = snapshot.sessionStatus;
  state.sessionError = snapshot.sessionError;
  state.status = 'ready';
  for (const change of outbox.changes.value) applyChange(state, change);
}

function createExplorationStore(explorationId: string) {
  const state = reactive<ExplorationState>({
    explorationId,
    status: 'loading',
    exploration: null,
    forks: new Map(),
    messages: new Map(),
    comments: new Map(),
    queuedSubmissions: new Map(),
    files: new Map(),
    replyDrafts: new Map(),
    noteGroups: new Map(),
    notes: new Map(),
    bookmarks: new Map(),
    sessionStatus: 'detached',
    sessionError: null,
    connected: false,
  });

  const load = async () => {
    try {
      applySnapshot(state, await api.snapshot(explorationId));
    } catch (error) {
      state.status = error instanceof ApiError && error.code === 'not_found' ? 'missing' : 'error';
    }
  };

  const stream = openEventStream({
    url: `/api/explorations/${explorationId}/events`,
    // Changes made while offline go first, so the reloaded chat already has them.
    onReady: async () => {
      state.connected = true;
      await outbox.flush();
      await load();
    },
    // EventSource reports the 404 of a missing exploration only as an error.
    onError: () => {
      state.connected = false;
      if (state.status !== 'loading') return;
      void load().then(() => {
        if (state.status === 'missing') stream.close();
      });
    },
    events: Object.fromEntries(
      eventTypes.map((type) => [type, (data: string) => applyServerEvent(state, JSON.parse(data))]),
    ),
  });
  return { state, close: stream.close };
}

let active: ReturnType<typeof createExplorationStore> | null = null;

export function whenActiveExplorationLoaded() {
  return new Promise<void>((resolve) => {
    if (!active || active.state.status !== 'loading') return resolve();
    const stop = watch(
      () => active?.state.status,
      (status) => {
        if (status === 'loading') return;
        stop();
        void nextTick(resolve);
      },
    );
  });
}

outbox.onChange((change) => {
  if (active) applyChange(active.state, change);
});

// A change the daemon refused leaves the page showing it, so the chat is loaded again.
outbox.onFailure(async (explorationId) => {
  if (active?.state.explorationId !== explorationId) return;
  const state = active.state;
  const snapshot = await api.snapshot(explorationId).catch(() => null);
  if (snapshot) applySnapshot(state, snapshot);
});

export function openExploration(explorationId: string) {
  if (active?.state.explorationId === explorationId) return active.state;
  active?.close();
  active = createExplorationStore(explorationId);
  return active.state;
}
