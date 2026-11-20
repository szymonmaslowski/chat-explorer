import { noNetwork } from '@shared/network';
import type {
  Activity,
  ActivitySummary,
  Bookmark,
  ChangeKind,
  ChangeSet,
  Comment,
  Exploration,
  ExplorationEvent,
  Fork,
  ForkRun,
  LightSnapshot,
  Message,
  MessageFile,
  MessageHead,
  Note,
  NoteGroup,
  QueuedSubmission,
  ReplyDraft,
  SessionStatus,
  Snapshot,
} from '@shared/types';
import { taggedIds } from '@shared/answer-tags';
import { joinForkGroup, leaveForkGroup } from '@shared/fork-groups';
import { defaultGroupName, noteForkMessage, reorderedIds } from '@shared/notes';
import { nextTick, reactive, toRaw, watch } from 'vue';
import { api, ApiError } from '../api';
import { openEventStream } from '../lib/event-stream';
import { keepImagesOffline } from '../lib/service-worker';
import {
  askForPersistentStorage,
  forgetChat,
  readBodies,
  readChat,
  storedBodyIds,
  writeBodies,
  writeChat,
  type StoredChat,
} from '../lib/local-store';
import { forkPath } from '../lib/conversation';
import {
  applyOrder,
  moveToBottomOfCategory,
  notesInGroup,
  renumberGroup,
  sortedGroups,
} from '../lib/notes';
import { outbox, subjectOf, type Change } from './outbox';

export interface ExplorationState {
  explorationId: string;
  status: 'loading' | 'ready' | 'missing' | 'deleted' | 'error';
  exploration: Exploration | null;
  // The change log's number this chat is up to date with; 0 when not known.
  seq: number;
  forks: Map<string, Fork>;
  // Every message of the chat, without its text.
  messages: Map<string, MessageHead>;
  // The texts loaded so far, by message. A message's text never changes.
  bodies: Map<string, string>;
  comments: Map<string, Comment>;
  queuedSubmissions: Map<string, QueuedSubmission>;
  files: Map<string, MessageFile>;
  // As loaded; the reply box takes over from there and saves its own changes.
  replyDrafts: Map<string, ReplyDraft>;
  noteGroups: Map<string, NoteGroup>;
  notes: Map<string, Note>;
  bookmarks: Map<string, Bookmark>;
  // By fork: what the runner is doing there.
  forkRuns: Map<string, ForkRun>;
  // The runner steps loaded so far: those of running attempts, and of attempts opened.
  activities: Map<string, Activity>;
  // Every attempt, counted, by attemptKey.
  activitySummaries: Map<string, ActivitySummary>;
  sessionStatus: SessionStatus;
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
  'note-groups.reordered',
  'note-group.deleted',
  'note.created',
  'note.updated',
  'note.deleted',
  'notes.reordered',
  'note.group-changed',
  'bookmark.created',
  'bookmark.deleted',
  'fork-run.updated',
  'reply-draft.updated',
  'activity.added',
  'activities.interrupted',
  'exploration.updated',
  'exploration.deleted',
  'session.status',
];

const sameValue = <Value>(shown: Value, next: Value) =>
  shown === next ||
  (typeof shown === 'object' &&
    typeof next === 'object' &&
    shown !== null &&
    next !== null &&
    JSON.stringify(shown) === JSON.stringify(next));

const ignoredFields = new Set<PropertyKey>(['updatedAt']);

// The same apart from when it was last changed, such as the daemon's notice of a change made
// here or an unchanged item in a reloaded chat.
function sameContent<Item extends object>(shown: Item, next: Item) {
  const shownFields = toRaw(shown);
  const keys = Object.keys(next) as (keyof Item)[];
  return (
    keys.length === Object.keys(shownFields).length &&
    keys.every((key) => ignoredFields.has(key) || sameValue(shownFields[key], next[key]))
  );
}

// Keeps what is shown when nothing in it changed, so the components showing it do not render
// again.
function put<Item extends object>(items: Map<string, Item>, key: string, item: Item) {
  const shown = items.get(key);
  if (!shown || !sameContent(shown, item)) items.set(key, item);
}

// A reloaded chat changes only what differs from what is shown.
function syncItems<Item extends object>(
  items: Map<string, Item>,
  next: Item[],
  keyOf: (item: Item) => string,
) {
  const keys = new Set(next.map(keyOf));
  for (const key of [...items.keys()]) if (!keys.has(key)) items.delete(key);
  for (const item of next) put(items, keyOf(item), item);
}

const byId = (item: { id: string }) => item.id;

export const attemptKey = (attempt: Pick<Activity, 'forkId' | 'afterMessageId' | 'attempt'>) =>
  `${attempt.forkId} ${attempt.afterMessageId} ${attempt.attempt}`;

const headOf = ({ content, ...message }: Message): MessageHead => ({
  ...message,
  answers: message.role === 'assistant' ? taggedIds(content) : [],
});

function putMessage(state: ExplorationState, message: Message) {
  put(state.messages, message.id, headOf(message));
  state.bodies.set(message.id, message.content);
  keepBody(state.explorationId, message.id, message.content);
}

function countActivity(state: ExplorationState, activity: Activity) {
  const key = attemptKey(activity);
  const summary = state.activitySummaries.get(key);
  state.activitySummaries.set(key, {
    forkId: activity.forkId,
    afterMessageId: activity.afterMessageId,
    attempt: activity.attempt,
    count: (summary?.count ?? 0) + 1,
    interrupted: (summary?.interrupted ?? false) || activity.interrupted,
    firstAt: summary?.firstAt ?? activity.createdAt,
    lastAt: activity.createdAt,
  });
}

export function applyReadChange(
  state: ExplorationState,
  messageIds: string[],
  readAt: number | null,
) {
  for (const messageId of messageIds) {
    const message = state.messages.get(messageId);
    // A new head, so the message shown with its text is made again.
    if (message) put(state.messages, messageId, { ...message, readAt });
  }
}

export function applyEvent(state: ExplorationState, event: ExplorationEvent) {
  switch (event.type) {
    case 'message.added':
      putMessage(state, event.message);
      put(state.forks, event.fork.id, event.fork);
      break;
    case 'messages.read':
      applyReadChange(state, event.messageIds, event.readAt);
      break;
    case 'fork.created':
    case 'fork.updated':
      put(state.forks, event.fork.id, event.fork);
      break;
    case 'fork.split':
      for (const fork of event.forks) put(state.forks, fork.id, fork);
      for (const message of event.messages) putMessage(state, message);
      for (const comment of event.comments) put(state.comments, comment.id, comment);
      for (const bookmark of event.bookmarks) put(state.bookmarks, bookmark.id, bookmark);
      for (const activity of event.activities) put(state.activities, activity.id, activity);
      for (const note of event.notes) put(state.notes, note.id, note);
      for (const run of event.forkRuns) put(state.forkRuns, run.forkId, run);
      break;
    case 'fork-run.updated':
      put(state.forkRuns, event.run.forkId, event.run);
      break;
    case 'reply-draft.updated':
      put(state.replyDrafts, event.draft.forkId, event.draft);
      break;
    case 'activity.added':
      if (!state.activities.has(event.activity.id)) countActivity(state, event.activity);
      put(state.activities, event.activity.id, event.activity);
      break;
    case 'activities.interrupted':
      for (const activity of state.activities.values()) {
        if (activity.forkId === event.forkId && activity.attempt === event.attempt) {
          put(state.activities, activity.id, { ...activity, interrupted: true });
        }
      }
      for (const [key, summary] of state.activitySummaries) {
        if (summary.forkId === event.forkId && summary.attempt === event.attempt) {
          state.activitySummaries.set(key, { ...summary, interrupted: true });
        }
      }
      break;
    case 'comment.created':
    case 'comment.updated':
      put(state.comments, event.comment.id, event.comment);
      break;
    case 'comment.deleted':
      state.comments.delete(event.commentId);
      break;
    case 'submission.queued':
      put(state.queuedSubmissions, event.submission.id, event.submission);
      break;
    case 'submission.cancelled':
    case 'submission.delivered':
      state.queuedSubmissions.delete(event.submissionId);
      break;
    case 'files.updated':
      for (const file of event.files) put(state.files, file.id, file);
      break;
    case 'files.released':
      for (const fileId of event.fileIds) state.files.delete(fileId);
      break;
    case 'note-group.created':
    case 'note-group.updated':
      put(state.noteGroups, event.group.id, event.group);
      break;
    case 'note-group.deleted':
      deleteNoteGroup(state, event.groupId);
      break;
    case 'note-groups.reordered':
      applyOrder(state.noteGroups, event.groupIds);
      break;
    case 'note.created':
    case 'note.updated':
      put(state.notes, event.note.id, event.note);
      break;
    case 'note.deleted':
      state.notes.delete(event.noteId);
      break;
    case 'notes.reordered':
      applyOrder(state.notes, event.noteIds);
      break;
    case 'note.group-changed':
      put(state.notes, event.note.id, event.note);
      applyOrder(state.notes, event.noteIds);
      break;
    case 'bookmark.created':
      put(state.bookmarks, event.bookmark.id, event.bookmark);
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
    case 'note-groups.reordered':
      return event.groupIds;
    case 'note.created':
    case 'note.updated':
      return [event.note.id];
    case 'note.group-changed':
      return [event.note.id, ...event.noteIds];
    case 'notes.reordered':
      return event.noteIds;
    case 'fork.split':
      return [
        ...event.comments.map((comment) => comment.id),
        ...event.notes.map((note) => note.id),
      ];
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
    if (comment) put(state.comments, commentId, { ...comment, forkGroupId });
  }
}

function leaveGroup(state: ExplorationState, comment: Comment) {
  if (!comment.forkGroupId) return;
  setGroups(state, leaveForkGroup(draftJoinableComments(state, comment.viewForkId), comment.id));
}

// Shows a change before the daemon has it, as the daemon will once it does.
// A fork the reader started, shown until the daemon's copy replaces it.
function addNewFork(
  state: ExplorationState,
  fork: Pick<Fork, 'parentForkId' | 'baseMessageId'> & { forkId: string },
  summary: string,
  now: number,
) {
  if (state.forks.has(fork.forkId)) return;
  put(state.forks, fork.forkId, {
    id: fork.forkId,
    explorationId: state.explorationId,
    parentForkId: fork.parentForkId,
    baseMessageId: fork.baseMessageId,
    originCommentId: null,
    tipMessageId: null,
    kind: 'soft',
    summary,
    awareness: 'aware',
    coding: false,
    network: noNetwork,
    createdAt: now,
    updatedAt: now,
    archivedAt: null,
    collapsed: false,
    needsSummary: false,
  });
}

export function applyChange(state: ExplorationState, change: Change) {
  if (change.explorationId !== state.explorationId) return;
  const now = Date.now();
  switch (change.type) {
    case 'comment.create': {
      const { id, editBody, type, fileIds, ...comment } = change.comment;
      const existing = state.comments.get(id);
      put(state.comments, id, {
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
        draftedByForkId: existing?.draftedByForkId ?? null,
        selected: change.comment.selected ?? existing?.selected ?? true,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
      });
      break;
    }
    case 'comment.update': {
      const comment = state.comments.get(change.commentId);
      const { body, editBody, type, noteGroupId, selected } = change.changes;
      if (!comment) break;
      if (type === 'note') leaveGroup(state, comment);
      put(state.comments, comment.id, {
        ...comment,
        body: body ?? comment.body,
        editBody: editBody === undefined ? comment.editBody : editBody,
        type: type ?? comment.type,
        noteGroupId: noteGroupId === undefined ? comment.noteGroupId : noteGroupId,
        selected: selected ?? comment.selected,
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
          put(state.comments, comment.id, { ...comment, forkGroupId: null });
        }
      }
      break;
    case 'reply-draft.save':
      break;
    case 'submit': {
      const { id, forkId, globalMessage, newFork, files } = change.submission;
      const allDrafts = [...state.comments.values()].filter(
        (comment) => comment.viewForkId === forkId && comment.status === 'draft',
      );
      const drafts = allDrafts.filter((comment) => comment.selected);
      for (const comment of allDrafts) {
        if (!comment.selected) put(state.comments, comment.id, { ...comment, selected: true });
      }
      // Note comments become notes without Claude; they wait here only for the daemon.
      for (const comment of drafts) {
        const isNote = comment.type === 'note';
        put(state.comments, comment.id, {
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
        put(state.queuedSubmissions, id, {
          id,
          explorationId: state.explorationId,
          forkId,
          globalMessage: globalMessage.trim(),
          newFork,
          createdAt: now,
        });
      }
      for (const file of files) put(state.files, file.id, { ...file, submissionId: id });
      break;
    }
    case 'fork-now': {
      const { submissionId: id, forkId, commentId } = change;
      put(state.queuedSubmissions, id, {
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
        put(state.comments, each.id, { ...each, status: 'queued', submissionId: id });
      }
      break;
    }
    case 'fork.create':
      addNewFork(state, change, '', now);
      break;
    case 'note.fork': {
      const { submissionId: id, forkId, noteId, message } = change;
      addNewFork(state, change, message.trim(), now);
      const note = state.notes.get(noteId);
      put(state.queuedSubmissions, id, {
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
          put(state.comments, comment.id, { ...comment, status: 'draft', submissionId: null });
        }
      }
      for (const file of state.files.values()) {
        if (file.submissionId === change.submissionId) state.files.delete(file.id);
      }
      break;
    case 'bookmark.create': {
      const existing = state.bookmarks.get(change.bookmark.id);
      put(state.bookmarks, change.bookmark.id, {
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
      put(state.noteGroups, id, {
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
      put(state.noteGroups, group.id, {
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
    case 'note-group.reorder': {
      const groupIds = sortedGroups(state.noteGroups).map((group) => group.id);
      applyOrder(state.noteGroups, reorderedIds(groupIds, change.groupId, change.afterGroupId));
      break;
    }
    // A rename keeps the notes where they are, so the section does not move.
    case 'note-group.rename-category': {
      const to = change.to?.trim() || null;
      for (const note of notesInGroup(state.notes, change.groupId)) {
        if (note.category === change.from.trim())
          put(state.notes, note.id, { ...note, category: to });
      }
      break;
    }
    case 'note.create': {
      const { id, groupId, topic, description, category } = change.note;
      const existing = state.notes.get(id);
      put(state.notes, id, {
        id,
        explorationId: state.explorationId,
        groupId,
        topic: topic?.trim() || null,
        description: description?.trim() ?? '',
        category: category?.trim() || null,
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
      moveToBottomOfCategory(state.notes, id, 'end');
      break;
    }
    case 'note.update': {
      const note = state.notes.get(change.noteId);
      if (!note) break;
      const { topic, description, category, checked } = change.changes;
      // The time stays the daemon's: the next edit is based on it.
      put(state.notes, note.id, {
        ...note,
        topic: topic === undefined ? note.topic : topic.trim() || null,
        description: description?.trim() ?? note.description,
        category: category === undefined ? note.category : category?.trim() || null,
        checked: checked ?? note.checked,
      });
      if (
        state.notes.get(note.id)?.category &&
        state.notes.get(note.id)?.category !== note.category
      ) {
        moveToBottomOfCategory(state.notes, note.id, 'stay');
      }
      break;
    }
    case 'note.delete':
      state.notes.delete(change.noteId);
      break;
    case 'note.keep': {
      const note = state.notes.get(change.noteId);
      if (note) put(state.notes, note.id, { ...note, deletionRequestedAt: null, updatedAt: now });
      break;
    }
    case 'note.reorder': {
      const note = state.notes.get(change.noteId);
      if (!note) break;
      const noteIds = notesInGroup(state.notes, note.groupId).map((each) => each.id);
      applyOrder(state.notes, reorderedIds(noteIds, note.id, change.afterNoteId));
      break;
    }
    case 'note.change-group': {
      const note = state.notes.get(change.noteId);
      if (!note || note.groupId === change.groupId) break;
      put(state.notes, note.id, {
        ...note,
        groupId: change.groupId,
        category: null,
        position: 0,
        updatedAt: now,
      });
      renumberGroup(state.notes, note.groupId);
      renumberGroup(state.notes, change.groupId);
      break;
    }
    case 'messages.read':
      applyReadChange(state, change.messageIds, change.at);
      break;
    case 'messages.unread': {
      const fork = state.forks.get(change.viewForkId);
      const path = fork ? forkPath(fork, state.messages) : [];
      const start = path.findIndex((message) => message.id === change.messageId);
      if (start === -1) break;
      const answers = path.slice(start).filter((message) => message.role === 'assistant');
      applyReadChange(
        state,
        answers.map((message) => message.id),
        null,
      );
      break;
    }
  }
}

const isFull = (snapshot: LightSnapshot | Snapshot): snapshot is Snapshot =>
  !('activitySummaries' in snapshot);

const applyPending = (state: ExplorationState) => {
  for (const change of outbox.changes.value) applyChange(state, change);
};

// A daemon from before the light load sends the whole chat, texts and all steps included.
export function applySnapshot(
  state: ExplorationState,
  snapshot: LightSnapshot | Snapshot,
  options = { withPending: true },
) {
  if (!state.exploration || !sameContent(state.exploration, snapshot.exploration)) {
    state.exploration = snapshot.exploration;
  }
  syncItems(state.forks, snapshot.forks, byId);
  if (isFull(snapshot)) {
    for (const message of snapshot.messages) state.bodies.set(message.id, message.content);
    syncItems(state.messages, snapshot.messages.map(headOf), byId);
    state.activitySummaries.clear();
    for (const activity of snapshot.activities) countActivity(state, activity);
  } else {
    syncItems(state.messages, snapshot.messages, byId);
    syncItems(state.activitySummaries, snapshot.activitySummaries, attemptKey);
    state.seq = snapshot.seq;
  }
  syncItems(state.comments, snapshot.comments, byId);
  syncItems(state.queuedSubmissions, snapshot.queuedSubmissions, byId);
  syncItems(state.files, snapshot.files, byId);
  syncItems(state.replyDrafts, snapshot.replyDrafts, (draft) => draft.forkId);
  syncItems(state.noteGroups, snapshot.noteGroups, byId);
  syncItems(state.notes, snapshot.notes, byId);
  syncItems(state.bookmarks, snapshot.bookmarks, byId);
  syncItems(state.forkRuns, snapshot.forkRuns, (run) => run.forkId);
  // Steps opened earlier stay loaded; the light load sends only those of running attempts.
  for (const activity of snapshot.activities) put(state.activities, activity.id, activity);
  state.sessionStatus = snapshot.sessionStatus;
  state.status = 'ready';
  if (options.withPending) applyPending(state);
}

// The device's copy of a chat, shown before the daemon answers, or instead of it offline.
export function applyStoredChat(
  state: ExplorationState,
  stored: StoredChat,
  options = { withPending: true },
) {
  state.exploration = stored.exploration;
  syncItems(state.forks, stored.forks, byId);
  syncItems(state.messages, stored.messages, byId);
  syncItems(state.comments, stored.comments, byId);
  syncItems(state.queuedSubmissions, stored.queuedSubmissions, byId);
  syncItems(state.files, stored.files, byId);
  syncItems(state.replyDrafts, stored.replyDrafts, (draft) => draft.forkId);
  syncItems(state.noteGroups, stored.noteGroups, byId);
  syncItems(state.notes, stored.notes, byId);
  syncItems(state.bookmarks, stored.bookmarks, byId);
  syncItems(state.forkRuns, stored.forkRuns, (run) => run.forkId);
  syncItems(state.activities, stored.activities, byId);
  syncItems(state.activitySummaries, stored.activitySummaries, attemptKey);
  state.seq = stored.seq;
  state.status = 'ready';
  if (options.withPending) applyPending(state);
}

export function toStoredChat(state: ExplorationState): StoredChat | null {
  if (!state.exploration) return null;
  const values = <Item>(items: Map<string, Item>) => [...items.values()].map((item) => toRaw(item));
  return {
    explorationId: state.explorationId,
    seq: state.seq,
    exploration: toRaw(state.exploration),
    forks: values(state.forks),
    messages: values(state.messages),
    comments: values(state.comments),
    queuedSubmissions: values(state.queuedSubmissions),
    files: values(state.files),
    replyDrafts: values(state.replyDrafts),
    noteGroups: values(state.noteGroups),
    notes: values(state.notes),
    bookmarks: values(state.bookmarks),
    forkRuns: values(state.forkRuns),
    activities: values(state.activities),
    activitySummaries: values(state.activitySummaries),
  };
}

// What changed since the copy shown, as the daemon has it now.
export function applyChangeSet(
  state: ExplorationState,
  changes: ChangeSet,
  options = { withPending: true },
) {
  if (changes.exploration) state.exploration = changes.exploration;
  for (const fork of changes.forks) put(state.forks, fork.id, fork);
  for (const message of changes.messages) putMessage(state, message);
  for (const comment of changes.comments) put(state.comments, comment.id, comment);
  for (const submission of changes.queuedSubmissions) {
    put(state.queuedSubmissions, submission.id, submission);
  }
  for (const file of changes.files) put(state.files, file.id, file);
  for (const draft of changes.replyDrafts) put(state.replyDrafts, draft.forkId, draft);
  for (const group of changes.noteGroups) put(state.noteGroups, group.id, group);
  for (const note of changes.notes) put(state.notes, note.id, note);
  for (const bookmark of changes.bookmarks) put(state.bookmarks, bookmark.id, bookmark);
  for (const run of changes.forkRuns) put(state.forkRuns, run.forkId, run);
  for (const activity of changes.activities) {
    if (!state.activities.has(activity.id)) countActivity(state, activity);
    put(state.activities, activity.id, activity);
  }
  for (const { kind, id } of changes.deleted) removeChanged(state, kind, id);
  state.sessionStatus = changes.sessionStatus;
  state.seq = changes.seq;
  state.status = state.exploration ? 'ready' : state.status;
  if (options.withPending) applyPending(state);
}

function removeChanged(state: ExplorationState, kind: ChangeKind, id: string) {
  const maps: Partial<Record<ChangeKind, Map<string, unknown>>> = {
    fork: state.forks,
    message: state.messages,
    comment: state.comments,
    submission: state.queuedSubmissions,
    file: state.files,
    reply_draft: state.replyDrafts,
    note_group: state.noteGroups,
    note: state.notes,
    bookmark: state.bookmarks,
    fork_run: state.forkRuns,
    activity: state.activities,
  };
  if (kind === 'exploration') state.status = 'deleted';
  maps[kind]?.delete(id);
}

export const emptyState = (explorationId: string): ExplorationState => ({
  explorationId,
  status: 'loading',
  exploration: null,
  seq: 0,
  forks: new Map(),
  messages: new Map(),
  bodies: new Map(),
  comments: new Map(),
  queuedSubmissions: new Map(),
  files: new Map(),
  replyDrafts: new Map(),
  noteGroups: new Map(),
  notes: new Map(),
  bookmarks: new Map(),
  forkRuns: new Map(),
  activities: new Map(),
  activitySummaries: new Map(),
  sessionStatus: 'detached',
  connected: false,
});

// Brings a chat up to date: from the change log after the copy's number when there is one, or
// with a fresh light load.
export async function catchUp(state: ExplorationState, options = { withPending: true }) {
  if (state.seq > 0 && state.exploration) {
    const changes = await api.changes(state.explorationId, state.seq);
    if (!changes.reset) return applyChangeSet(state, changes, options);
  }
  applySnapshot(state, await api.snapshot(state.explorationId), options);
}

const saveDelayMs = 1_000;

function createExplorationStore(explorationId: string) {
  const state = reactive<ExplorationState>(emptyState(explorationId));
  askForPersistentStorage();

  let saveTimer: ReturnType<typeof setTimeout> | undefined;
  const save = () => {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      const chat = toStoredChat(state);
      if (chat) void writeChat(chat);
      saveBodies(explorationId);
    }, saveDelayMs);
  };

  const restored = readChat(explorationId).then((stored) => {
    if (stored && state.status === 'loading') applyStoredChat(state, stored);
  });

  // Live events move the copy's number on, except while it catches up from an older one.
  let catchingUp = false;
  let filled = false;
  let caughtUp = false;
  const load = async () => {
    await restored;
    catchingUp = true;
    try {
      await catchUp(state);
      caughtUp = true;
      save();
      if (!filled) {
        filled = true;
        void fillBodies(state).then(() =>
          keepImagesOffline(
            [...state.files.values()]
              .filter((file) => file.kind === 'image')
              .map((file) => file.id),
          ),
        );
      }
    } catch (error) {
      if (error instanceof ApiError && error.code === 'not_found') {
        state.status = 'missing';
        void forgetChat(explorationId);
      } else if (state.status !== 'ready') {
        state.status = 'error';
      }
    } finally {
      catchingUp = false;
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
    // EventSource reports the 404 of a missing exploration only as an error. A copy shown from
    // the device asks the daemon too, until it reaches it once, to learn of a deleted chat.
    onError: () => {
      state.connected = false;
      if (state.status !== 'loading' && caughtUp) return;
      if (catchingUp) return;
      void load().then(() => {
        if (state.status === 'missing') stream.close();
      });
    },
    events: Object.fromEntries(
      eventTypes.map((type) => [
        type,
        (data: string) => {
          const event: ExplorationEvent & { seq?: number } = JSON.parse(data);
          applyServerEvent(state, event);
          // Without a copy loaded yet there is nothing the number could be the state of.
          if (!catchingUp && state.exploration && event.seq !== undefined) {
            state.seq = Math.max(state.seq, event.seq);
          }
          save();
          // A split moves messages and steps to a new fork, so the counted attempts come again.
          if (event.type === 'fork.split') void load();
        },
      ]),
    ),
  });
  return { state, close: stream.close };
}

let active: ReturnType<typeof createExplorationStore> | null = null;
export const activeExplorationId = () => active?.state.explorationId ?? null;

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

const loadingBodies = new Map<string, Promise<void>>();
const maxBodiesPerRequest = 200;

// Texts loaded from the daemon or arrived live, not on the device yet, by chat.
const unsavedBodies = new Map<string, Map<string, string>>();
const keepBody = (explorationId: string, id: string, content: string) => {
  const unsaved = unsavedBodies.get(explorationId) ?? new Map<string, string>();
  unsaved.set(id, content);
  unsavedBodies.set(explorationId, unsaved);
};
export function saveBodies(explorationId: string) {
  const unsaved = unsavedBodies.get(explorationId);
  if (!unsaved?.size) return;
  unsavedBodies.delete(explorationId);
  void writeBodies(explorationId, unsaved);
}

async function fetchBodies(state: ExplorationState, messageIds: string[]) {
  const stored = await readBodies(messageIds);
  for (const [id, content] of stored) state.bodies.set(id, content);
  const missing = messageIds.filter((id) => !stored.has(id));
  for (let start = 0; start < missing.length; start += maxBodiesPerRequest) {
    const bodies = await api.messageBodies(
      state.explorationId,
      missing.slice(start, start + maxBodiesPerRequest),
    );
    for (const body of bodies) {
      state.bodies.set(body.id, body.content);
      keepBody(state.explorationId, body.id, body.content);
    }
  }
  saveBodies(state.explorationId);
}

// Loads the texts of these messages that are not loaded yet: from the device, or else from the
// daemon, a request per batch.
export async function loadBodies(state: ExplorationState, messageIds: string[]) {
  const missing = messageIds.filter((id) => !state.bodies.has(id) && !loadingBodies.has(id));
  if (missing.length > 0) {
    const settled = fetchBodies(state, missing).finally(() => {
      for (const id of missing) loadingBodies.delete(id);
    });
    for (const id of missing) loadingBodies.set(id, settled);
  }
  await Promise.all(messageIds.flatMap((id) => loadingBodies.get(id) ?? []));
}

const fillPauseMs = 200;

// Puts the texts of every message of the chat on the device, a batch at a time, without keeping
// them in memory, so the whole chat reads offline.
export async function fillBodies(state: Pick<ExplorationState, 'explorationId' | 'messages'>) {
  const stored = await storedBodyIds(state.explorationId);
  const missing = [...state.messages.keys()].filter((id) => !stored.has(id));
  for (let start = 0; start < missing.length; start += maxBodiesPerRequest) {
    try {
      const bodies = await api.messageBodies(
        state.explorationId,
        missing.slice(start, start + maxBodiesPerRequest),
      );
      await writeBodies(
        state.explorationId,
        bodies.map((body) => [body.id, body.content] as [string, string]),
      );
    } catch {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, fillPauseMs));
  }
}

export async function loadAttemptActivities(state: ExplorationState, summary: ActivitySummary) {
  const activities = await api.attemptActivities(state.explorationId, summary);
  for (const activity of activities) put(state.activities, activity.id, activity);
}
