<script setup lang="ts">
import { autonomousAreaLabels, autonomousAreas, type AutonomousArea } from '@shared/requests';
import type { Fork } from '@shared/types';
import { computed, ref } from 'vue';
import { api } from '../api';
import { offline } from '../lib/online';

// What Claude may ask for in this fork, and what of it runs without the user's approval. Only the
// main fork can coordinate other forks.
const props = defineProps<{ fork: Fork }>();

const isMain = computed(() => props.fork.parentForkId === null);
const saving = ref(false);
const failed = ref(false);

async function save(change: () => Promise<unknown>) {
  saving.value = true;
  failed.value = false;
  try {
    await change();
  } catch {
    failed.value = true;
  } finally {
    saving.value = false;
  }
}

const setCoordination = (coordination: boolean) =>
  save(() => api.setForkCoordination(props.fork.id, coordination));
const setArea = (area: AutonomousArea, on: boolean) =>
  save(() =>
    api.setForkAutonomous(
      props.fork.id,
      on ? [...props.fork.autonomous, area] : props.fork.autonomous.filter((each) => each !== area),
    ),
  );
</script>

<template>
  <section class="fork-requests" aria-label="Requests">
    <h2>Requests</h2>
    <label class="setting" :class="{ unavailable: !isMain }">
      <input
        type="checkbox"
        :checked="fork.coordination"
        :disabled="!isMain || saving || offline"
        @change="setCoordination(($event.target as HTMLInputElement).checked)"
      />
      Coordination
    </label>
    <p class="muted">
      <template v-if="isMain">
        Claude may ask to start forks, message them and change their settings. Each request waits
        for your approval on a card here.
      </template>
      <template v-else>Only the chat's main fork can coordinate other forks.</template>
    </p>

    <fieldset>
      <legend>Autonomous: these run without asking you</legend>
      <label v-for="area in autonomousAreas" :key="area" class="setting">
        <input
          type="checkbox"
          :checked="fork.autonomous.includes(area)"
          :disabled="saving || offline"
          @change="setArea(area, ($event.target as HTMLInputElement).checked)"
        />
        {{ autonomousAreaLabels[area] }}
      </label>
    </fieldset>
    <p class="muted">
      Coding, hosts, registries, credentials and the model always wait for your approval. New forks
      without a card are limited per hour by the runner's config.
    </p>
    <p v-if="fork.autonomous.length > 0" class="warning">
      A fork that reads hostile content, such as a web page or a README, could use these to act
      without you.
    </p>
    <p v-if="failed" class="error" role="alert">Could not save the setting.</p>
  </section>
</template>

<style scoped>
.fork-requests {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 0.5rem;
}

h2 {
  margin: 0;
  font-size: 1rem;
}

.setting {
  display: flex;
  align-items: center;
  gap: 0.5rem;
}

.unavailable {
  opacity: 0.55;
}

fieldset {
  display: flex;
  flex-direction: column;
  gap: 0.3rem;
  border: none;
  margin: 0;
  padding: 0;
}

legend {
  margin-bottom: 0.3rem;
  padding: 0;
}

p {
  margin: 0;
  font-size: 0.9rem;
}

.warning {
  color: var(--warning);
}

.error {
  color: var(--danger);
}
</style>
