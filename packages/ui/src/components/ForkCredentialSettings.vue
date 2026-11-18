<script setup lang="ts">
import { credentialNamePattern, maxCredentials } from '@shared/network';
import type { CapabilitiesReport, Fork } from '@shared/types';
import { computed, ref } from 'vue';
import { api } from '../api';

// Which of the runner's credentials a coding fork's container gets. The runner's config holds
// them, each paired with its hosts; the backend only keeps the names this fork picked.
const props = defineProps<{ fork: Fork; report: CapabilitiesReport | null }>();

const saving = ref(false);
const typedName = ref('');

const offered = computed(() => props.report?.capabilities.credentials ?? []);
// Picked names the report doesn't list: credentials the runner keeps hidden.
const hiddenPicked = computed(() =>
  props.fork.network.credentials.filter(
    (name) => !offered.value.some((credential) => credential.name === name),
  ),
);
const typedValid = computed(() => credentialNamePattern.test(typedName.value.trim()));

async function setCredential(name: string, picked: boolean) {
  const others = props.fork.network.credentials.filter((credential) => credential !== name);
  const credentials = picked ? [...others, name].slice(0, maxCredentials) : others;
  saving.value = true;
  try {
    await api.setForkNetwork(props.fork.id, { ...props.fork.network, credentials });
  } finally {
    saving.value = false;
  }
}

async function addTyped() {
  await setCredential(typedName.value.trim(), true);
  typedName.value = '';
}
</script>

<template>
  <div class="credentials">
    <fieldset>
      <legend>Credentials from the runner's config</legend>
      <p v-if="!report" class="hint">The runner hasn't said which credentials it has.</p>
      <p v-else-if="offered.length === 0 && hiddenPicked.length === 0" class="hint">
        None. Add them under coding.credentials in the runner's config.
      </p>
      <label
        v-for="credential in offered"
        :key="credential.name"
        :title="credential.hosts.join('\n')"
      >
        <input
          type="checkbox"
          :checked="fork.network.credentials.includes(credential.name)"
          :disabled="saving"
          @change="setCredential(credential.name, ($event.target as HTMLInputElement).checked)"
        />
        {{ credential.name }} ({{ credential.type === 'token' ? 'token' : 'SSH key' }} for
        {{ credential.hosts.join(', ') || 'hidden hosts' }})
      </label>
      <label v-for="name in hiddenPicked" :key="name">
        <input
          type="checkbox"
          checked
          :disabled="saving"
          @change="setCredential(name, ($event.target as HTMLInputElement).checked)"
        />
        {{ name }} (kept hidden by the runner)
      </label>
    </fieldset>
    <form class="typed" @submit.prevent="addTyped">
      <input
        v-model="typedName"
        aria-label="A hidden credential's name"
        placeholder="A hidden credential's name"
        spellcheck="false"
        autocapitalize="off"
      />
      <button type="submit" :disabled="saving || !typedValid">Add</button>
    </form>
    <p v-if="fork.network.credentials.length > 0" class="warning" role="note">
      Claude can read these credentials and use them anywhere on their hosts: github.com means all
      of GitHub, including pushing this workspace or this chat to a repository someone else owns.
      Use narrow tokens and deploy keys, never your personal SSH key.
    </p>
    <p class="hint">A change reaches the container when it restarts.</p>
  </div>
</template>

<style scoped>
.credentials {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 0.4rem;
  margin: 0.2rem 0 0.4rem 1.4rem;
}

fieldset {
  display: flex;
  flex-direction: column;
  gap: 0.2rem;
  margin: 0;
  padding: 0;
  border: none;
}

legend {
  padding: 0;
  margin-bottom: 0.2rem;
}

label {
  display: flex;
  align-items: center;
  gap: 0.4rem;
}

.typed {
  display: flex;
  gap: 0.4rem;
}

p {
  margin: 0;
}

.warning {
  color: var(--warning);
  font-size: 0.85em;
}

.hint {
  color: var(--text-muted);
  font-size: 0.85em;
}
</style>
