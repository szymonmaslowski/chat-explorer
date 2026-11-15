// Keeps the app's files, so it opens with no network, and every image of the chats, as the
// original files. The build fills in the version and the list of the app's files.
const version = '__VERSION__';
const appFiles = __APP_FILES__;
const appCache = `app-${version}`;
const imageCache = 'images';

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(appCache).then((cache) => cache.addAll(appFiles)));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((key) => key.startsWith('app-') && key !== appCache)
            .map((key) => caches.delete(key)),
        ),
      )
      .then(() => self.clients.claim()),
  );
});

// The page asks for the new version to take over once the reader chose to reload.
self.addEventListener('message', (event) => {
  if (event.data === 'skip-waiting') self.skipWaiting();
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  // Pages come from the daemon when it answers, so a new version shows at once; offline, the
  // kept page starts the app.
  if (request.mode === 'navigate') {
    event.respondWith(fetch(request).catch(() => caches.match('/', { cacheName: appCache })));
    return;
  }
  if (url.pathname.startsWith('/api/files/')) {
    event.respondWith(keptImage(request));
    return;
  }
  if (url.pathname.startsWith('/api/')) return;
  event.respondWith(caches.match(request).then((kept) => kept ?? fetch(request)));
});

// An uploaded file never changes, so a kept image is served as it is.
async function keptImage(request) {
  const cache = await caches.open(imageCache);
  const kept = await cache.match(request);
  if (kept) return kept;
  const response = await fetch(request);
  const isImage = (response.headers.get('content-type') ?? '').startsWith('image/');
  if (response.ok && isImage) await cache.put(request, response.clone());
  return response;
}
