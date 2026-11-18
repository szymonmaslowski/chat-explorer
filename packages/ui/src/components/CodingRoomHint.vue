<script setup lang="ts">
import type { CodingCapacity, Fork, ForkRun } from '@shared/types';
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import { api } from '../api';

// Before you send in a coding fork: whether Docker has memory free for its container, or the
// message will wait until it has.
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

const shown = (bytes: number) => `${(Math.max(bytes, 0) / 1024 ** 3).toFixed(1)} GB`;
const short = computed(() => {
  const room = capacity.value;
  if (!room || room.availableBytes === null || props.run?.status === 'waiting_memory') return null;
  if (room.forkIds.includes(props.fork.id) || room.availableBytes >= room.neededBytes) return null;
  return { free: shown(room.availableBytes), needed: shown(room.neededBytes) };
});
</script>

<template>
  <p v-if="short" class="coding-room muted" role="status">
    Docker is low on memory: {{ short.free }} free, and a coding fork needs {{ short.needed }} to
    start. A message sent now waits until there's room.
  </p>
</template>

<style scoped>
.coding-room {
  margin: 0.4rem 0;
  font-size: 0.9em;
}
</style>
