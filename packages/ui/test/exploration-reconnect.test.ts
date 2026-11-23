import type { ChangeSet, Exploration, LightSnapshot, MessageHead } from '@shared/types';
import { expect, it, vi } from 'vitest';
import type { StoredChat } from '../src/lib/local-store';

type StreamInput = Parameters<typeof import('../src/lib/event-stream').openEventStream>[0];
const streams: StreamInput[] = [];
vi.mock('../src/lib/event-stream', () => ({
  openEventStream: (input: StreamInput) => {
    streams.push(input);
    return { close: () => {} };
  },
}));

const exploration = { id: 'chat_e', title: '', boardColumns: [] } as unknown as Exploration;
const stored: StoredChat = {
  explorationId: 'chat_e',
  seq: 10,
  exploration,
  forks: [],
  messages: [],
  comments: [],
  queuedSubmissions: [],
  files: [],
  replyDrafts: [],
  noteGroups: [],
  notes: [],
  bookmarks: [],
  forkRuns: [],
  activities: [],
  activitySummaries: [],
  requests: [],
};
const storedChats = new Map<string, Partial<StoredChat>>();
vi.mock('../src/lib/local-store', () => ({
  askForPersistentStorage: () => {},
  forgetChat: async () => {},
  readBodies: async () => [],
  readChat: async (explorationId: string) => ({ ...stored, ...storedChats.get(explorationId) }),
  storedBodyIds: async () => new Set<string>(),
  writeBodies: async () => {},
  writeChat: async () => {},
}));
vi.mock('../src/lib/service-worker', () => ({ keepImagesOffline: () => {} }));

const head = (id: string, parentId: string | null): MessageHead => ({
  id,
  explorationId: 'chat_gap',
  forkId: 'fork_main',
  parentId,
  role: 'user',
  source: 'live',
  createdAt: 0,
  readAt: null,
  answers: [],
});

const changesAfter: number[] = [];
const snapshotsOf: string[] = [];
vi.mock('../src/api', async (importOriginal) => {
  const { ApiError } = await importOriginal<typeof import('../src/api')>();
  return {
    ApiError,
    api: {
      changes: async (_explorationId: string, after: number): Promise<ChangeSet> => {
        changesAfter.push(after);
        return {
          seq: 30,
          reset: false,
          exploration: null,
          forks: [],
          messages: [],
          comments: [],
          queuedSubmissions: [],
          files: [],
          replyDrafts: [],
          noteGroups: [],
          notes: [],
          bookmarks: [],
          forkRuns: [],
          activities: [],
          requests: [],
          deleted: [],
          sessionStatus: 'listening',
        };
      },
      snapshot: async (explorationId: string): Promise<LightSnapshot> => {
        snapshotsOf.push(explorationId);
        return {
          ...stored,
          requests: [],
          exploration: { ...exploration, id: explorationId },
          messages: [head('m1', null), head('m2', 'm1'), head('m3', 'm2')],
          sessionStatus: 'listening',
          seq: 40,
        };
      },
      messageBodies: async () => [],
    },
  };
});

const { openExploration } = await import('../src/stores/exploration');

it('catches up from its own copy after a reconnect, even when a live event comes first', async () => {
  const state = openExploration('chat_e');
  await vi.waitFor(() => expect(state.seq).toBe(10));
  const stream = streams.at(-1)!;

  // The page reconnects, and an event with the daemon's newest number arrives before the page
  // has asked what it missed while it was away.
  const ready = stream.onReady();
  stream.events['session.status']!(
    JSON.stringify({ type: 'session.status', status: 'answering', seq: 25 }),
  );
  await ready;

  expect(changesAfter).toEqual([10]);
  expect(state.seq).toBe(30);
});

it('loads the chat again whole when its copy misses a message another one answers', async () => {
  // A copy saved by an older page, after it skipped m2 on a reconnect.
  storedChats.set('chat_gap', {
    explorationId: 'chat_gap',
    exploration: { ...exploration, id: 'chat_gap' },
    messages: [head('m1', null), head('m3', 'm2')],
  });
  const state = openExploration('chat_gap');
  await vi.waitFor(() => expect(state.seq).toBe(10));
  await streams.at(-1)!.onReady();

  expect(snapshotsOf).toEqual(['chat_gap']);
  expect([...state.messages.keys()].sort()).toEqual(['m1', 'm2', 'm3']);
});
