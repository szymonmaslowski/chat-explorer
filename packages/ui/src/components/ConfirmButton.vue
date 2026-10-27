<script setup lang="ts">
import { onBeforeUnmount, ref } from 'vue';

defineProps<{ label: string; danger?: boolean }>();
const emit = defineEmits<{ confirm: [] }>();

const confirmWindowMs = 3_000;
const armed = ref(false);
const button = ref<HTMLButtonElement | null>(null);
let disarmTimer: ReturnType<typeof setTimeout> | undefined;

function onPointerDownOutside(event: PointerEvent) {
  if (!(event.target instanceof Node && button.value?.contains(event.target))) disarm();
}

function arm() {
  armed.value = true;
  disarmTimer = setTimeout(disarm, confirmWindowMs);
  document.addEventListener('pointerdown', onPointerDownOutside, true);
}

function disarm() {
  clearTimeout(disarmTimer);
  armed.value = false;
  document.removeEventListener('pointerdown', onPointerDownOutside, true);
}

function onClick() {
  if (!armed.value) return arm();
  disarm();
  emit('confirm');
}

onBeforeUnmount(disarm);
</script>

<template>
  <button ref="button" type="button" :class="{ armed, danger }" @click="onClick">
    {{ armed ? 'Confirm' : label }}
  </button>
</template>

<style scoped>
.armed {
  background: var(--warning);
  border-color: var(--warning);
  color: var(--background);
}

.danger {
  color: var(--danger);
  border-color: var(--danger);
}

.danger.armed {
  background: var(--danger);
  color: var(--background);
}
</style>
