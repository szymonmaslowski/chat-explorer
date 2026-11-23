<script setup lang="ts">
import { describeAction, type ActionRequest } from '@shared/requests';
import { computed, ref, watch } from 'vue';
import { scrollToAndFlash } from '../lib/flash';

// Above the reply box while Claude's requests wait in this fork: a click goes to the oldest card,
// and the list has a line for each card.
const props = defineProps<{ requests: ActionRequest[] }>();

const open = ref(false);
const count = computed(() =>
  props.requests.reduce((total, request) => total + request.items.length, 0),
);
watch(
  () => props.requests.length,
  (length) => {
    if (length < 2) open.value = false;
  },
);

function jump(request: ActionRequest) {
  const card = document.getElementById(`r-${request.id}`);
  if (card) scrollToAndFlash(card, 'below-header');
}

const lineOf = (request: ActionRequest) => {
  const [first, ...rest] = request.items;
  if (!first) return '';
  return `${describeAction(first.original)}${rest.length > 0 ? ` and ${rest.length} more` : ''}`;
};
</script>

<template>
  <div v-if="requests.length > 0" class="request-bar" role="status">
    <div class="main">
      <button type="button" class="jump" @click="jump(requests[0]!)">
        {{ count }} request{{ count === 1 ? '' : 's' }} waiting
      </button>
      <button
        v-if="requests.length > 1"
        type="button"
        class="toggle"
        :aria-expanded="open"
        :aria-label="open ? 'Hide the list of cards' : `List the ${requests.length} cards`"
        @click="open = !open"
      >
        {{ requests.length }} cards {{ open ? '▾' : '▸' }}
      </button>
    </div>
    <ul v-if="open">
      <li v-for="request in requests" :key="request.id">
        <button type="button" class="line" @click="jump(request)">{{ lineOf(request) }}</button>
      </li>
    </ul>
  </div>
</template>

<style scoped>
.request-bar {
  margin: 0 0 0.4rem;
  padding: 0.35rem 0.6rem;
  border-radius: var(--radius);
  background: var(--caution);
  color: var(--on-caution);
  font-size: 0.9rem;
}

.main {
  display: flex;
  align-items: center;
  gap: 0.5rem;
}

button {
  border: none;
  background: none;
  color: inherit;
  padding: 0.1rem 0.2rem;
}

.jump {
  flex: 1;
  text-align: left;
  font-weight: 600;
}

ul {
  list-style: none;
  margin: 0.3rem 0 0;
  padding: 0;
}

.line {
  width: 100%;
  text-align: left;
  text-decoration: underline;
}
</style>
