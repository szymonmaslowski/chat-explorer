<script setup lang="ts">
import type { Attention } from '../lib/read-state';

defineProps<{ attention: Attention }>();
</script>

<template>
  <span
    class="attention-dot"
    :class="attention"
    role="img"
    :aria-label="attention === 'unread' ? 'New answer' : 'Claude could not answer'"
    :title="attention === 'unread' ? 'New answer' : 'Claude could not answer'"
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

.attention-dot.failed {
  background: var(--danger);
}
</style>
