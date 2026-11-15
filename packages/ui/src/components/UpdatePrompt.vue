<script setup lang="ts">
import { reloadIntoNewVersion, waitingVersion } from '../lib/service-worker';
</script>

<template>
  <div v-if="waitingVersion" class="update-prompt" role="status">
    <span>A new version of the app is ready.</span>
    <button type="button" class="primary" @click="reloadIntoNewVersion">Reload</button>
  </div>
</template>

<style scoped>
/* Centred by its margins, not by moving it half its width: a box placed from the middle may
   only be half the screen wide, which squeezed the button. */
.update-prompt {
  position: fixed;
  z-index: 20;
  top: calc(env(safe-area-inset-top) + 0.5rem);
  left: 0;
  right: 0;
  width: fit-content;
  max-width: calc(100vw - 2rem);
  margin-inline: auto;
  display: flex;
  align-items: center;
  gap: 0.75rem;
  padding: 0.5rem 0.5rem 0.5rem 1rem;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 999px;
  box-shadow: var(--shadow);
  font-size: 0.9rem;
}

.update-prompt button {
  flex: none;
  white-space: nowrap;
  border-radius: 999px;
}
</style>
