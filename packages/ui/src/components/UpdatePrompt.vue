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
.update-prompt {
  position: fixed;
  z-index: 20;
  left: 50%;
  top: calc(env(safe-area-inset-top) + 0.5rem);
  transform: translateX(-50%);
  display: flex;
  align-items: center;
  gap: 0.75rem;
  max-width: calc(100vw - 2rem);
  padding: 0.5rem 0.5rem 0.5rem 0.9rem;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  box-shadow: var(--shadow);
  font-size: 0.9rem;
}
</style>
