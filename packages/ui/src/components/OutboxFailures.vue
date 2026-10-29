<script setup lang="ts">
import { computed } from 'vue';
import { outbox } from '../stores/outbox';

const props = defineProps<{ explorationId: string }>();

const failures = computed(() =>
  outbox.failures.filter((failure) => failure.explorationId === props.explorationId),
);
</script>

<template>
  <p v-for="failure in failures" :key="failure.key" class="outbox-failure" role="alert">
    {{ failure.message }}
    <button type="button" @click="outbox.dismissFailure(failure.key)">Dismiss</button>
  </p>
</template>

<style scoped>
.outbox-failure {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.5rem;
  margin: 0.4rem 0 0;
  color: var(--danger);
}
</style>
