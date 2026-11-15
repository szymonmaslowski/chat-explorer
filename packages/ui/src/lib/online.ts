import { computed, ref } from 'vue';
import { outbox } from '../stores/outbox';

const browserOnline = ref(navigator.onLine);
window.addEventListener('online', () => (browserOnline.value = true));
window.addEventListener('offline', () => (browserOnline.value = false));

// Whether the page's live connection to the daemon is open, as its event streams last found.
const daemonReached = ref(true);
export const reportDaemonReached = (reached: boolean) => (daemonReached.value = reached);

// Offline: no network, or the daemon out of reach, or changes that could not be sent.
export const offline = computed(
  () => !browserOnline.value || !daemonReached.value || outbox.stalled.value,
);

export const notOffline = 'Not available offline';
