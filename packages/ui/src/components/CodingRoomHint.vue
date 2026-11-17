<script setup lang="ts">
import type { CodingCapacity, Fork, ForkRun } from '@shared/types';
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import { api } from '../api';

// Before you send in a coding fork: whether Docker's memory has room for its container, or the
// message will wait until another coding fork lets its container go.
const props = defineProps<{ fork: Fork; run: ForkRun | null }>();

const capacityRefreshMs = 20_000;
const capacity = ref<CodingCapacity | null>(null);
let timer: ReturnType<typeof setInterval> | undefined;

async function refresh() {
  capacity.value = await api
    .codingCapacity()
    .then((result) => result.capacity)
    .catch(() => null);
}

watch(
  () => props.fork.coding,
  (coding) => {
    clearInterval(timer);
    capacity.value = null;
    if (!coding) return;
    void refresh();
    timer = setInterval(() => void refresh(), capacityRefreshMs);
  },
  { immediate: true },
);
watch(
  () => props.run?.status,
  () => props.fork.coding && void refresh(),
);
onBeforeUnmount(() => clearInterval(timer));

const full = computed(() => {
  const room = capacity.value;
  if (!room || room.slots === 0 || props.run?.status === 'waiting_memory') return false;
  return !room.forkIds.includes(props.fork.id) && room.forkIds.length >= room.slots;
});
const running = computed(() => {
  const room = capacity.value!;
  return room.slots === 1
    ? `another coding fork is using it (${room.memory})`
    : `${room.slots} coding forks are using it (${room.memory} each)`;
});
</script>

<template>
  <p v-if="full" class="coding-room muted" role="status">
    Docker's memory for coding is taken: {{ running }}. A message sent now waits until one of them
    goes idle.
  </p>
</template>

<style scoped>
.coding-room {
  margin: 0.4rem 0;
  font-size: 0.9em;
}
</style>
