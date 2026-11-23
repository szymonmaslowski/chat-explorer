<script setup lang="ts">
import { claudeModels, type ClaudeModel } from '@shared/models';
import { packageRegistries, registryNames, type RegistryName } from '@shared/network';
import type { ForkSettingsChanges, RequestAction } from '@shared/requests';
import type { Fork, NoteGroup } from '@shared/types';
import { computed } from 'vue';
import { forkTitle } from '../lib/conversation';

// The fields of one requested action, for the user to change before approving. Ids of what the
// action creates stay as Claude picked them.
const props = defineProps<{
  action: RequestAction;
  forks: Fork[];
  noteGroups: NoteGroup[];
  credentialNames: string[];
}>();
const emit = defineEmits<{ update: [action: RequestAction] }>();

const update = (changes: Partial<RequestAction>) =>
  emit('update', { ...props.action, ...changes } as RequestAction);

const lines = (text: string) =>
  text
    .split('\n')
    .map((line) => line.trim().toLowerCase())
    .filter(Boolean);
const toggled = <Item,>(list: Item[], item: Item, on: boolean) =>
  on ? [...list.filter((each) => each !== item), item] : list.filter((each) => each !== item);
const modelValue = (value: string): ClaudeModel | null =>
  value === '' ? null : (value as ClaudeModel);

const settings = computed(() =>
  props.action.kind === 'fork_settings' ? props.action.changes : null,
);
const updateSettings = (changes: ForkSettingsChanges) => {
  if (props.action.kind !== 'fork_settings') return;
  update({ changes: { ...props.action.changes, ...changes } });
};
// The fork or group a message or a move goes to.
const targetId = computed(() =>
  props.action.kind === 'message'
    ? props.action.forkId
    : props.action.kind === 'note_group_change'
      ? props.action.groupId
      : '',
);
// Credentials of the runner, and any a request names that the runner didn't report.
const credentialChoices = (chosen: string[]) => [...new Set([...props.credentialNames, ...chosen])];
</script>

<template>
  <div class="editor">
    <template v-if="action.kind === 'fork'">
      <label class="field">
        <span>Title</span>
        <input
          :value="action.title"
          @input="update({ title: ($event.target as HTMLInputElement).value })"
        />
      </label>
      <label class="field">
        <span>Brief: the fork's first message</span>
        <textarea
          :value="action.brief"
          rows="6"
          @input="update({ brief: ($event.target as HTMLTextAreaElement).value })"
        />
      </label>
      <div class="row">
        <label class="check">
          <input
            type="checkbox"
            :checked="action.awareness === 'aware'"
            @change="
              update({
                awareness: ($event.target as HTMLInputElement).checked ? 'aware' : 'separate',
              })
            "
          />
          Aware of the chat
        </label>
        <label class="check">
          <input
            type="checkbox"
            :checked="action.coding"
            @change="update({ coding: ($event.target as HTMLInputElement).checked })"
          />
          Coding
        </label>
        <label class="check">
          Model
          <select
            :value="action.model ?? ''"
            @change="update({ model: modelValue(($event.target as HTMLSelectElement).value) })"
          >
            <option value="">The chat's</option>
            <option v-for="model in claudeModels" :key="model" :value="model">{{ model }}</option>
          </select>
        </label>
      </div>
      <fieldset class="row">
        <legend>Registries</legend>
        <label v-for="name in registryNames" :key="name" class="check">
          <input
            type="checkbox"
            :checked="action.registries.includes(name)"
            @change="
              update({
                registries: toggled<RegistryName>(
                  action.registries,
                  name,
                  ($event.target as HTMLInputElement).checked,
                ),
              })
            "
          />
          {{ packageRegistries[name].label }}
        </label>
      </fieldset>
      <label class="field">
        <span>Hosts, one host:port a line</span>
        <textarea
          :value="action.hosts.join('\n')"
          rows="2"
          @change="update({ hosts: lines(($event.target as HTMLTextAreaElement).value) })"
        />
      </label>
      <fieldset v-if="credentialChoices(action.credentials).length > 0" class="row">
        <legend>Credentials</legend>
        <label v-for="name in credentialChoices(action.credentials)" :key="name" class="check">
          <input
            type="checkbox"
            :checked="action.credentials.includes(name)"
            @change="
              update({
                credentials: toggled(
                  action.credentials,
                  name,
                  ($event.target as HTMLInputElement).checked,
                ),
              })
            "
          />
          {{ name }}
        </label>
      </fieldset>
    </template>

    <template v-else-if="action.kind === 'message'">
      <label class="field">
        <span>To fork</span>
        <select
          :value="action.forkId"
          @change="update({ forkId: ($event.target as HTMLSelectElement).value })"
        >
          <option v-if="!forks.some((fork) => fork.id === targetId)" :value="targetId">
            {{ targetId }} (to be created)
          </option>
          <option v-for="fork in forks" :key="fork.id" :value="fork.id">
            {{ forkTitle(fork) }}
          </option>
        </select>
      </label>
      <label class="field">
        <span>Message</span>
        <textarea
          :value="action.text"
          rows="4"
          @input="update({ text: ($event.target as HTMLTextAreaElement).value })"
        />
      </label>
    </template>

    <template v-else-if="settings && action.kind === 'fork_settings'">
      <label v-if="settings.title !== undefined" class="field">
        <span>Title</span>
        <input
          :value="settings.title"
          @input="updateSettings({ title: ($event.target as HTMLInputElement).value })"
        />
      </label>
      <div class="row">
        <label v-if="settings.awareness !== undefined" class="check">
          <input
            type="checkbox"
            :checked="settings.awareness === 'aware'"
            @change="
              updateSettings({
                awareness: ($event.target as HTMLInputElement).checked ? 'aware' : 'separate',
              })
            "
          />
          Aware of the chat
        </label>
        <label v-if="settings.coding !== undefined" class="check">
          <input
            type="checkbox"
            :checked="settings.coding"
            @change="updateSettings({ coding: ($event.target as HTMLInputElement).checked })"
          />
          Coding
        </label>
        <label v-if="settings.model !== undefined" class="check">
          Model
          <select
            :value="settings.model ?? ''"
            @change="
              updateSettings({ model: modelValue(($event.target as HTMLSelectElement).value) })
            "
          >
            <option value="">The chat's</option>
            <option v-for="model in claudeModels" :key="model" :value="model">{{ model }}</option>
          </select>
        </label>
      </div>
      <fieldset v-if="settings.registries" class="row">
        <legend>Registries</legend>
        <label v-for="name in registryNames" :key="name" class="check">
          <input
            type="checkbox"
            :checked="settings.registries.includes(name)"
            @change="
              updateSettings({
                registries: toggled<RegistryName>(
                  settings.registries,
                  name,
                  ($event.target as HTMLInputElement).checked,
                ),
              })
            "
          />
          {{ packageRegistries[name].label }}
        </label>
      </fieldset>
      <label v-if="settings.hosts" class="field">
        <span>Hosts, one host:port a line</span>
        <textarea
          :value="settings.hosts.join('\n')"
          rows="2"
          @change="updateSettings({ hosts: lines(($event.target as HTMLTextAreaElement).value) })"
        />
      </label>
      <fieldset v-if="settings.credentials" class="row">
        <legend>Credentials</legend>
        <label v-for="name in credentialChoices(settings.credentials)" :key="name" class="check">
          <input
            type="checkbox"
            :checked="settings.credentials.includes(name)"
            @change="
              updateSettings({
                credentials: toggled(
                  settings.credentials,
                  name,
                  ($event.target as HTMLInputElement).checked,
                ),
              })
            "
          />
          {{ name }}
        </label>
      </fieldset>
    </template>

    <template v-else-if="action.kind === 'note_group'">
      <label class="field">
        <span>Name</span>
        <input
          :value="action.name"
          @input="update({ name: ($event.target as HTMLInputElement).value })"
        />
      </label>
      <label class="check">
        <input
          type="checkbox"
          :checked="action.checklist"
          @change="update({ checklist: ($event.target as HTMLInputElement).checked })"
        />
        Checklist
      </label>
    </template>

    <template v-else-if="action.kind === 'notes'">
      <div v-for="(note, index) in action.notes" :key="index" class="note">
        <label class="field">
          <span>Topic</span>
          <input
            :value="note.topic ?? ''"
            @input="
              update({
                notes: action.notes.map((each, at) =>
                  at === index
                    ? { ...each, topic: ($event.target as HTMLInputElement).value }
                    : each,
                ),
              })
            "
          />
        </label>
        <label class="field">
          <span>Description</span>
          <textarea
            :value="note.description ?? ''"
            rows="3"
            @input="
              update({
                notes: action.notes.map((each, at) =>
                  at === index
                    ? { ...each, description: ($event.target as HTMLTextAreaElement).value }
                    : each,
                ),
              })
            "
          />
        </label>
      </div>
    </template>

    <template v-else-if="action.kind === 'note_update'">
      <label v-if="action.topic !== undefined" class="field">
        <span>Topic</span>
        <input
          :value="action.topic"
          @input="update({ topic: ($event.target as HTMLInputElement).value })"
        />
      </label>
      <label v-if="action.description !== undefined" class="field">
        <span>Description</span>
        <textarea
          :value="action.description"
          rows="4"
          @input="update({ description: ($event.target as HTMLTextAreaElement).value })"
        />
      </label>
      <label v-if="action.category !== undefined" class="field">
        <span>Category</span>
        <input
          :value="action.category ?? ''"
          @input="update({ category: ($event.target as HTMLInputElement).value || null })"
        />
      </label>
    </template>

    <template v-else-if="action.kind === 'note_group_change'">
      <label class="field">
        <span>To group</span>
        <select
          :value="action.groupId"
          @change="update({ groupId: ($event.target as HTMLSelectElement).value })"
        >
          <option v-if="!noteGroups.some((group) => group.id === targetId)" :value="targetId">
            {{ targetId }} (to be created)
          </option>
          <option v-for="group in noteGroups" :key="group.id" :value="group.id">
            {{ group.name }}
          </option>
        </select>
      </label>
    </template>

    <template v-else-if="action.kind === 'note_category'">
      <label class="field">
        <span>New name (empty removes the category)</span>
        <input
          :value="action.to ?? ''"
          @input="update({ to: ($event.target as HTMLInputElement).value || null })"
        />
      </label>
    </template>

    <p v-else class="muted">Nothing to change here.</p>
  </div>
</template>

<style scoped>
.editor {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
  padding: 0.5rem 0 0.25rem 1.6rem;
}

.field {
  display: flex;
  flex-direction: column;
  gap: 0.2rem;
  font-size: 0.85rem;
}

.field span {
  color: var(--text-muted);
}

.field textarea,
.field input,
.field select {
  font: inherit;
  width: 100%;
}

.row {
  display: flex;
  flex-wrap: wrap;
  gap: 0.4rem 1rem;
  font-size: 0.85rem;
  border: none;
  margin: 0;
  padding: 0;
}

legend {
  color: var(--text-muted);
  padding: 0;
  margin-bottom: 0.2rem;
  width: 100%;
}

.check {
  display: inline-flex;
  align-items: center;
  gap: 0.3rem;
}

.note {
  border-left: 2px solid var(--border);
  padding-left: 0.5rem;
}
</style>
