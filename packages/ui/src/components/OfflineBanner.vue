<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { markStoreSetUp, storeWasSetUp } from '../lib/local-store';
import { takeRemovalNotice } from '../lib/offline-data';
import { offline } from '../lib/online';
import { outbox } from '../stores/outbox';

const unsent = computed(() => outbox.changes.value.length);

// Safari outside the home screen may clear what a site keeps after seven days without a visit.
const userAgent = navigator.userAgent;
const isSafari =
  /Safari/.test(userAgent) && !/Chrome|Chromium|CriOS|FxiOS|EdgiOS|Android/.test(userAgent);
const fromHomeScreen =
  matchMedia('(display-mode: standalone)').matches ||
  (navigator as Navigator & { standalone?: boolean }).standalone === true;
const mayBeCleared = isSafari && !fromHomeScreen;

// The daemon's cookie outlives what the page keeps. An old cookie with an empty store means the
// browser cleared this device's copy, with any changes not sent by then.
const cleared = ref(false);
const firstVisitMs = 60 * 60 * 1000;
onMounted(async () => {
  const removedOnPurpose = takeRemovalNotice();
  if (await storeWasSetUp()) return;
  if (removedOnPurpose) return void markStoreSetUp();
  const device = /(?:^|; )ce_device=[^.;]+\.(\d+)/.exec(document.cookie);
  const cookieAge = device ? Date.now() - Number(device[1]) : 0;
  cleared.value = cookieAge > firstVisitMs;
  void markStoreSetUp();
});
</script>

<template>
  <div v-if="cleared" class="banner cleared" role="alert">
    <span>
      This device's offline copy was cleared, probably by the browser. Changes not sent before then
      may be lost.
    </span>
    <button type="button" @click="cleared = false">OK</button>
  </div>
  <div v-if="offline" class="banner offline" role="status">
    <span>
      Offline<template v-if="unsent > 0">
        · {{ unsent }} change{{ unsent === 1 ? '' : 's' }} will send when online</template
      >.
      <template v-if="mayBeCleared && unsent > 0">
        Safari may delete them if the app isn't opened for 7 days. Add it to the Home Screen to keep
        them safe.
      </template>
    </span>
  </div>
</template>

<style scoped>
/* Above the page, scrolling away with it: the chat's header, which stays, shows the unsent count
   too. */
.banner {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  padding: 0.4rem 1rem;
  font-size: 0.85rem;
  background: var(--surface);
  border-bottom: 1px solid var(--border);
}

.offline {
  color: var(--warning);
}

.cleared button {
  margin-left: auto;
}
</style>
