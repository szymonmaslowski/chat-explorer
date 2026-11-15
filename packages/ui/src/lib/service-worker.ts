import { ref } from 'vue';

const updateCheckMs = 30 * 60 * 1000;

// A new version of the app, installed and waiting for the reader to reload into it.
export const waitingVersion = ref<ServiceWorker | null>(null);
let reloadOnTakeover = false;

export function registerServiceWorker() {
  if (!import.meta.env.PROD || !('serviceWorker' in navigator)) return;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (reloadOnTakeover) location.reload();
  });
  void navigator.serviceWorker
    .register('/sw.js')
    .then((registration) => {
      // Only an update waits: the first worker takes over a page that had none.
      const offer = (worker: ServiceWorker | null) => {
        if (worker && navigator.serviceWorker.controller) waitingVersion.value = worker;
      };
      offer(registration.waiting);
      registration.addEventListener('updatefound', () => {
        const worker = registration.installing;
        worker?.addEventListener('statechange', () => {
          if (worker.state === 'installed') offer(worker);
        });
      });
      // An app left open, as on a phone's home screen, looks for a new version now and then.
      const check = () => void registration.update().catch(() => {});
      setInterval(check, updateCheckMs);
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') check();
      });
    })
    .catch(() => {});
}

export function reloadIntoNewVersion() {
  const worker = waitingVersion.value;
  if (!worker) return;
  reloadOnTakeover = true;
  worker.postMessage('skip-waiting');
}

// Fetched once through the worker, an image is kept for offline use.
export async function keepImagesOffline(fileIds: string[]) {
  if (!navigator.serviceWorker?.controller) return;
  for (const fileId of fileIds) {
    await fetch(`/api/files/${fileId}`)
      .then((response) => response.blob())
      .catch(() => {});
  }
}
