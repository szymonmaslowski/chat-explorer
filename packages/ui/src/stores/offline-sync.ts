import type { ExplorationListItem } from '@shared/types';
import { readChat, writeChat } from '../lib/local-store';
import { keepImagesOffline } from '../lib/service-worker';
import {
  activeExplorationId,
  applyStoredChat,
  catchUp,
  emptyState,
  fillBodies,
  saveBodies,
  toStoredChat,
} from './exploration';

const pauseMs = 300;

// The chats brought up to date on the device in this session, at the time each last changed.
const syncedAt = new Map<string, number>();
let queue: ExplorationListItem[] = [];
let running = false;

// Keeps every chat of the list on the device, one at a time in the background, so each opens
// offline. The chat open on the page keeps itself up to date.
export function syncChats(chats: ExplorationListItem[]) {
  queue = chats.filter((chat) => syncedAt.get(chat.id) !== chat.updatedAt);
  if (!running) void run();
}

async function run() {
  running = true;
  while (queue.length > 0) {
    const chat = queue.shift()!;
    const synced = chat.id === activeExplorationId() || (await sync(chat));
    if (synced) syncedAt.set(chat.id, chat.updatedAt);
    await new Promise((resolve) => setTimeout(resolve, pauseMs));
  }
  running = false;
}

async function sync(chat: ExplorationListItem) {
  const state = emptyState(chat.id);
  try {
    const stored = await readChat(chat.id);
    if (stored) applyStoredChat(state, stored, { withPending: false });
    await catchUp(state, { withPending: false });
    const record = toStoredChat(state);
    if (record) await writeChat(record);
    saveBodies(chat.id);
    await fillBodies(state);
    await keepImagesOffline(
      [...state.files.values()].filter((file) => file.kind === 'image').map((file) => file.id),
    );
    return true;
  } catch {
    // Offline, or the chat went: the next list load tries again.
    return false;
  }
}
