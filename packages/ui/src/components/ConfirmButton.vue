<script setup lang="ts">
import { onBeforeUnmount, ref } from 'vue';

defineProps<{ label: string }>();
const emit = defineEmits<{ confirm: [] }>();

const confirmWindowMs = 3_000;
const armed = ref(false);
let disarmTimer: ReturnType<typeof setTimeout> | undefined;

function disarm() {
  clearTimeout(disarmTimer);
  armed.value = false;
}

function onClick() {
  if (armed.value) {
    disarm();
    emit('confirm');
    return;
  }
  armed.value = true;
  disarmTimer = setTimeout(disarm, confirmWindowMs);
}

onBeforeUnmount(disarm);
</script>

<template>
  <button type="button" :class="{ armed }" @click="onClick">
    {{ armed ? 'Confirm' : label }}
  </button>
</template>

<style scoped>
.armed {
  background: var(--warning);
  border-color: var(--warning);
  color: var(--background);
}
</style>
