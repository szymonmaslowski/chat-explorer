import { outbox } from '../stores/outbox';
import { clearLocalStore } from './local-store';

const removedKey = 'chat-explorer.offline-data-removed';

// Removes everything the app keeps on this device: the chats, the queue of unsent changes, the
// kept images and app files, and the service worker. The page then starts again from the daemon.
export async function removeOfflineData() {
  outbox.clear();
  await clearLocalStore();
  if ('caches' in window) {
    for (const key of await caches.keys()) await caches.delete(key);
  }
  for (const registration of (await navigator.serviceWorker?.getRegistrations()) ?? []) {
    await registration.unregister();
  }
  try {
    localStorage.setItem(removedKey, '1');
  } catch {}
  location.replace('/');
}

// After a removal the reader asked for, an empty store is no sign of the browser clearing it.
export function takeRemovalNotice() {
  try {
    const removed = localStorage.getItem(removedKey) !== null;
    localStorage.removeItem(removedKey);
    return removed;
  } catch {
    return false;
  }
}
