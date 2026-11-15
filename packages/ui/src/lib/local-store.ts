import type {
  Activity,
  ActivitySummary,
  Bookmark,
  Comment,
  Exploration,
  ExplorationListItem,
  Fork,
  ForkRun,
  MessageFile,
  MessageHead,
  Note,
  NoteGroup,
  QueuedSubmission,
  ReplyDraft,
} from '@shared/types';

// The device's copy of every chat, in IndexedDB: each chat as one record without message texts,
// the texts by message, and the list of chats. A chat's record knows the change log's number it
// is up to date with.
export interface StoredChat {
  explorationId: string;
  seq: number;
  exploration: Exploration;
  forks: Fork[];
  messages: MessageHead[];
  comments: Comment[];
  queuedSubmissions: QueuedSubmission[];
  files: MessageFile[];
  replyDrafts: ReplyDraft[];
  noteGroups: NoteGroup[];
  notes: Note[];
  bookmarks: Bookmark[];
  forkRuns: ForkRun[];
  activities: Activity[];
  activitySummaries: ActivitySummary[];
}

interface StoredBody {
  id: string;
  explorationId: string;
  content: string;
}

const databaseName = 'chat-explorer';
const chats = 'chats';
const bodies = 'bodies';
const lists = 'lists';

let opening: Promise<IDBDatabase | null> | null = null;

// Null where IndexedDB is missing or refused, as in some private windows: the app then works
// online only, as before.
function database() {
  opening ??= new Promise<IDBDatabase | null>((resolve) => {
    let request: IDBOpenDBRequest;
    try {
      request = indexedDB.open(databaseName, 1);
    } catch {
      return resolve(null);
    }
    request.onupgradeneeded = () => {
      const db = request.result;
      db.createObjectStore(chats, { keyPath: 'explorationId' });
      db.createObjectStore(bodies, { keyPath: 'id' }).createIndex('byChat', 'explorationId');
      db.createObjectStore(lists);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => resolve(null);
    request.onblocked = () => resolve(null);
  });
  return opening;
}

const done = <Value>(request: IDBRequest<Value>) =>
  new Promise<Value>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });

const finished = (transaction: IDBTransaction) =>
  new Promise<void>((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error);
  });

// Storage trouble never breaks the page: what was not read is loaded from the daemon instead.
async function attempt<Result>(work: (db: IDBDatabase) => Promise<Result>, fallback: Result) {
  const db = await database();
  if (!db) return fallback;
  try {
    return await work(db);
  } catch {
    return fallback;
  }
}

export const readChat = (explorationId: string) =>
  attempt<StoredChat | null>(
    async (db) => (await done(db.transaction(chats).objectStore(chats).get(explorationId))) ?? null,
    null,
  );

export const writeChat = (chat: StoredChat) =>
  attempt(async (db) => {
    const transaction = db.transaction(chats, 'readwrite');
    transaction.objectStore(chats).put(chat);
    await finished(transaction);
  }, undefined);

export const readBodies = (messageIds: string[]) =>
  attempt(async (db) => {
    const store = db.transaction(bodies).objectStore(bodies);
    const found = await Promise.all(
      messageIds.map((id) => done(store.get(id) as IDBRequest<StoredBody | undefined>)),
    );
    return new Map(found.flatMap((body) => (body ? [[body.id, body.content] as const] : [])));
  }, new Map<string, string>());

export const writeBodies = (explorationId: string, entries: Iterable<[string, string]>) =>
  attempt(async (db) => {
    const transaction = db.transaction(bodies, 'readwrite');
    const store = transaction.objectStore(bodies);
    for (const [id, content] of entries) store.put({ id, explorationId, content });
    await finished(transaction);
  }, undefined);

// The ids of a chat's messages whose texts are on the device.
export const storedBodyIds = (explorationId: string) =>
  attempt(
    async (db) =>
      new Set(
        (await done(
          db.transaction(bodies).objectStore(bodies).index('byChat').getAllKeys(explorationId),
        )) as string[],
      ),
    new Set<string>(),
  );

export const readList = (key: string) =>
  attempt<ExplorationListItem[] | null>(
    async (db) => (await done(db.transaction(lists).objectStore(lists).get(key))) ?? null,
    null,
  );

export const writeList = (key: string, items: ExplorationListItem[]) =>
  attempt(async (db) => {
    const transaction = db.transaction(lists, 'readwrite');
    transaction.objectStore(lists).put(items, key);
    await finished(transaction);
  }, undefined);

export const forgetChat = (explorationId: string) =>
  attempt(async (db) => {
    const transaction = db.transaction([chats, bodies], 'readwrite');
    transaction.objectStore(chats).delete(explorationId);
    const index = transaction.objectStore(bodies).index('byChat');
    for (const key of await done(index.getAllKeys(explorationId))) {
      transaction.objectStore(bodies).delete(key);
    }
    await finished(transaction);
  }, undefined);

// Removes every chat from the device.
export async function clearLocalStore() {
  const db = await database();
  db?.close();
  opening = null;
  await new Promise<void>((resolve) => {
    const request = indexedDB.deleteDatabase(databaseName);
    request.onsuccess = request.onerror = request.onblocked = () => resolve();
  });
}

// Asks the browser to keep the chats when space runs low. Browsers decide on their own, so a
// refusal changes nothing else.
let persistenceAsked = false;
export function askForPersistentStorage() {
  if (persistenceAsked) return;
  persistenceAsked = true;
  void navigator.storage?.persist?.().catch(() => false);
}

const deviceMarker = 'device-seen';

// Whether this device's store was set up before, so a store found empty can be told apart from a
// first visit.
export const storeWasSetUp = () =>
  attempt(
    async (db) => (await done(db.transaction(lists).objectStore(lists).get(deviceMarker))) === true,
    true,
  );

export const markStoreSetUp = () =>
  attempt(async (db) => {
    const transaction = db.transaction(lists, 'readwrite');
    transaction.objectStore(lists).put(true, deviceMarker);
    await finished(transaction);
  }, undefined);
