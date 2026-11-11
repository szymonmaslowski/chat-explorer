<script setup lang="ts">
import { useCopied } from '../composables/useCopied';
import MediaIcon from './MediaIcon.vue';

const props = defineProps<{ label: string; id: string }>();
const { copied, copy } = useCopied();
</script>

<template>
  <div class="copyable-id">
    <span class="muted">{{ props.label }}</span>
    <code>{{ props.id }}</code>
    <button
      type="button"
      :aria-label="copied ? 'Copied' : `Copy ${props.label}`"
      :title="copied ? 'Copied' : `Copy ${props.label}`"
      @click="copy({ plain: props.id })"
    >
      <MediaIcon :name="copied ? 'check' : 'copy'" />
    </button>
  </div>
</template>

<style scoped>
.copyable-id {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.3rem;
}

button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 2rem;
  min-height: 1.75rem;
  padding: 0.2rem 0.45rem;
}
</style>
