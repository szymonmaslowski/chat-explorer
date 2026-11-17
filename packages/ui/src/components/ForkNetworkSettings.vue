<script setup lang="ts">
import { isHostPort, maxAllowedHosts, registryHosts } from '@shared/network';
import type { Fork } from '@shared/types';
import { computed, ref, watch } from 'vue';
import { api } from '../api';

// What a coding fork's container may reach: the registries preset and hosts the reader typed.
const props = defineProps<{ fork: Fork }>();

const saving = ref(false);
const draft = ref(props.fork.network.hosts.join('\n'));
watch(
  () => props.fork.network.hosts,
  (hosts) => (draft.value = hosts.join('\n')),
);

const entries = computed(() =>
  draft.value
    .split('\n')
    .map((line) => line.trim().toLowerCase())
    .filter(Boolean),
);
const invalid = computed(() => entries.value.filter((entry) => !isHostPort(entry)));
const tooMany = computed(() => entries.value.length > maxAllowedHosts);
const changed = computed(() => entries.value.join('\n') !== props.fork.network.hosts.join('\n'));

async function save(network: Fork['network']) {
  saving.value = true;
  try {
    await api.setForkNetwork(props.fork.id, network);
  } finally {
    saving.value = false;
  }
}

const setRegistries = (registries: boolean) => save({ ...props.fork.network, registries });
const saveHosts = () => save({ ...props.fork.network, hosts: entries.value });
</script>

<template>
  <div class="network">
    <label :title="registryHosts.join('\n')">
      <input
        type="checkbox"
        :checked="fork.network.registries"
        :disabled="saving"
        @change="setRegistries(($event.target as HTMLInputElement).checked)"
      />
      Package registries: npm, PyPI, crates.io, Go
    </label>
    <label class="hosts">
      Other allowed hosts, one per line as name:port
      <textarea
        v-model="draft"
        rows="3"
        spellcheck="false"
        autocapitalize="off"
        placeholder="github.com:443"
      />
    </label>
    <p v-if="invalid.length > 0" class="error" role="alert">
      Not a host and port: {{ invalid.join(', ') }}
    </p>
    <p v-else-if="tooMany" class="error" role="alert">At most {{ maxAllowedHosts }} hosts.</p>
    <button
      v-if="changed"
      type="button"
      :disabled="saving || invalid.length > 0 || tooMany"
      @click="saveHosts"
    >
      Save hosts
    </button>
    <p class="hint">
      Everything else is refused, and so are addresses on your own network. Changes apply to new
      connections at once.
    </p>
  </div>
</template>

<style scoped>
.network {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 0.4rem;
  margin: 0.2rem 0 0.4rem 1.4rem;
}

label {
  display: flex;
  align-items: center;
  gap: 0.4rem;
}

.hosts {
  flex-direction: column;
  align-items: stretch;
  align-self: stretch;
}

textarea {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 0.9em;
  resize: vertical;
}

p {
  margin: 0;
}

.error {
  color: var(--danger);
  font-size: 0.85em;
}

.hint {
  color: var(--text-muted);
  font-size: 0.85em;
}
</style>
