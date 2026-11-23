<script setup lang="ts">
import type { Attention } from '../lib/read-state';

defineProps<{ attention: Attention }>();
</script>

<template>
  <span
    class="attention-dot"
    :class="attention"
    role="img"
    :aria-label="attention === 'request' ? 'Requests waiting for you' : 'New answer'"
    :title="attention === 'request' ? 'Requests waiting for you' : 'New answer'"
  />
</template>

<style scoped>
.attention-dot {
  display: inline-block;
  flex: none;
  width: 0.6rem;
  height: 0.6rem;
  border-radius: 50%;
  background: var(--accent);
}

.attention-dot.request {
  background: var(--caution);
  box-shadow: 0 0 0 2px light-dark(rgb(245 158 11 / 0.3), rgb(251 191 36 / 0.3));
}
</style>
