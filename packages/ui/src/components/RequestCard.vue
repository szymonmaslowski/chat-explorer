<script setup lang="ts">
import {
  allowableAreas,
  allowAreaLabel,
  allowAreaNames,
  attachesCredential,
  type AutonomousArea,
  describeAction,
  editedFields,
  type ActionRequest,
  type RequestAction,
  type RequestItem,
} from '@shared/requests';
import type { Fork, Note, NoteGroup } from '@shared/types';
import { computed, reactive, ref, watch } from 'vue';
import { api } from '../api';
import { useAutosave } from '../composables/useAutosave';
import { notOffline, offline } from '../lib/online';
import { outbox } from '../stores/outbox';
import { forkTitle } from '../lib/conversation';
import { decisionSummary, outcomeLabel } from '../lib/requests';
import ConfirmButton from './ConfirmButton.vue';
import RequestItemEditor from './RequestItemEditor.vue';

// A card of actions Claude asked for. While it waits, each item can be unticked or edited, and
// Approve and Reject each take a second click; once decided it is a read-only record.
const props = defineProps<{
  request: ActionRequest;
  explorationId: string;
  forks: Map<string, Fork>;
  noteGroups: Map<string, NoteGroup>;
  notes: Map<string, Note>;
  credentialNames: string[];
}>();
const emit = defineEmits<{ decided: [request: ActionRequest] }>();

const waiting = computed(() => props.request.status === 'waiting');
const selected = reactive(new Map<string, boolean>());
const drafts = reactive(new Map<string, RequestAction>());
const open = reactive(new Set<string>());
const reason = ref('');
const allow = reactive(new Set<AutonomousArea>());
const busy = ref(false);
const error = ref('');

const copy = (action: RequestAction) => JSON.parse(JSON.stringify(action)) as RequestAction;

// Edits are saved as the card's draft through the outbox, like every write of the page: kept on
// the device until the daemon has them, sent in order, and shown again after a reload. A save
// from another device replaces what is shown, except what is being changed here: an item or the
// reason with the focus, a change not saved yet, or one still waiting in the outbox (the card
// then shows that one, as the outbox replays it over the daemon's copy).
const dirty = new Set<string>();
const reasonKey = ' reason';
const allowKey = ' allow';
let focused: string | null = null;
const focus = (key: string | null) => (focused = key);

function draftEntry(itemId: string) {
  return props.request.draft?.items.find((entry) => entry.id === itemId);
}

// Items added to the card while it is shown start as the saved draft has them, or else ticked
// and as Claude asked.
watch(
  () => props.request.items,
  (items) => {
    for (const item of items) {
      const saved = draftEntry(item.id);
      if (!selected.has(item.id)) selected.set(item.id, saved?.selected ?? true);
      if (!drafts.has(item.id)) drafts.set(item.id, copy(saved?.action ?? item.original));
    }
  },
  { immediate: true },
);
reason.value = props.request.draft?.reason ?? '';
for (const area of props.request.draft?.allowAreas ?? []) allow.add(area);

watch(
  () => props.request.draft,
  (draft) => {
    if (!draft) return;
    for (const entry of draft.items) {
      if (dirty.has(entry.id) || focused === entry.id) continue;
      selected.set(entry.id, entry.selected);
      drafts.set(entry.id, copy(entry.action));
    }
    if (!dirty.has(reasonKey) && focused !== reasonKey) reason.value = draft.reason;
    if (!dirty.has(allowKey)) {
      allow.clear();
      for (const area of draft.allowAreas) allow.add(area);
    }
  },
);

const currentDraft = () => ({
  items: props.request.items.map((item) => ({
    id: item.id,
    selected: selected.get(item.id) !== false,
    action: drafts.get(item.id) ?? item.original,
  })),
  reason: reason.value,
  allowAreas: [...allow],
});

function queueDraft() {
  if (!waiting.value) return;
  dirty.clear();
  outbox.add({
    type: 'request.draft',
    explorationId: props.explorationId,
    requestId: props.request.id,
    draft: currentDraft(),
  });
}

const autosave = useAutosave(queueDraft);

function changed(key: string) {
  dirty.add(key);
  autosave.changed();
}

const setSelected = (itemId: string, value: boolean) => {
  selected.set(itemId, value);
  changed(itemId);
};
const setDraft = (itemId: string, action: RequestAction) => {
  drafts.set(itemId, action);
  changed(itemId);
};
const setAllowed = (area: AutonomousArea, value: boolean) => {
  if (value) allow.add(area);
  else allow.delete(area);
  changed(allowKey);
};
const onReasonInput = () => changed(reasonKey);

// Approve and Reject need the daemon: they are decisions, not drafts, so they never wait in the
// outbox.
const unreachable = computed(() => offline.value);

const tickedCount = computed(
  () => props.request.items.filter((item) => selected.get(item.id) !== false).length,
);
const actionOf = (item: RequestItem) => drafts.get(item.id) ?? item.original;
// A checkbox for each area of the card the Autonomous setting can cover and doesn't yet; it
// counts only while one of that area's items is ticked.
const alreadyAllowed = computed(() => props.forks.get(props.request.forkId)?.autonomous ?? []);
const offeredAreas = computed(() =>
  allowableAreas(props.request.items.map(actionOf)).filter(
    (area) => !alreadyAllowed.value.includes(area),
  ),
);
const tickedAreas = computed(
  () =>
    new Set(
      allowableAreas(
        props.request.items.filter((item) => selected.get(item.id) !== false).map(actionOf),
      ),
    ),
);
const allowedNow = computed(() =>
  offeredAreas.value.filter((area) => allow.has(area) && tickedAreas.value.has(area)),
);
const allowedRecord = computed(() =>
  props.request.allowedAreas.map((area) => allowAreaNames[area]).join(', '),
);
const editedNow = (item: RequestItem) => editedFields(item.original, drafts.get(item.id) ?? null);

const otherForks = computed(() =>
  [...props.forks.values()].filter(
    (fork) => fork.id !== props.request.forkId && fork.archivedAt === null,
  ),
);

// What an item does, naming forks and notes by their titles where the page knows them.
function title(action: RequestAction) {
  let text = describeAction(action);
  for (const [id, fork] of props.forks) text = text.replace(` ${id}`, ` "${forkTitle(fork)}"`);
  for (const [id, group] of props.noteGroups) text = text.replace(`group ${id}`, `"${group.name}"`);
  for (const [id, note] of props.notes) {
    text = text.replace(`note ${id}`, `note "${note.topic ?? note.description.slice(0, 40)}"`);
  }
  return text;
}

const shown = (item: RequestItem) => item.final ?? drafts.get(item.id) ?? item.original;

function resultLink(item: RequestItem) {
  if (item.outcome !== 'done' || !item.resultId) return null;
  const action = shown(item);
  if (action.kind === 'fork' || action.kind === 'fork_settings' || action.kind === 'message') {
    const forkId = action.forkId;
    return { to: `/e/${props.explorationId}/f/${forkId}`, label: 'Open the fork' };
  }
  if (
    action.kind === 'notes' ||
    action.kind === 'note_update' ||
    action.kind === 'note_group_change'
  ) {
    return { to: `/e/${props.explorationId}/notes#n-${item.resultId}`, label: 'Open the note' };
  }
  return null;
}

const originalValue = (action: RequestAction, field: string): string => {
  const source =
    action.kind === 'fork_settings'
      ? (action.changes as Record<string, unknown>)
      : action.kind === 'board'
        ? (action.input as unknown as Record<string, unknown>)
        : (action as unknown as Record<string, unknown>);
  const value = source[field];
  if (typeof value === 'string') return value;
  return JSON.stringify(value ?? null);
};

async function decide(decision: 'approve' | 'reject') {
  busy.value = true;
  error.value = '';
  try {
    // The latest edits go first, through the outbox, so the draft never lags behind the decision.
    autosave.finish(queueDraft);
    await outbox.flush();
    if (outbox.isPending(props.request.id)) {
      throw new Error('The daemon could not be reached. Try again when it is back.');
    }
    const request = await api.decideRequest(props.request.id, {
      decision,
      ...(decision === 'approve'
        ? {
            items: props.request.items.map((item) => ({
              id: item.id,
              selected: selected.get(item.id) !== false,
              action: drafts.get(item.id) ?? item.original,
            })),
            ...(allowedNow.value.length > 0 && { allowAreas: allowedNow.value }),
          }
        : { reason: reason.value.trim() || null }),
    });
    emit('decided', request);
  } catch (caught) {
    error.value = caught instanceof Error ? caught.message : String(caught);
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <section
    :id="`r-${request.id}`"
    class="request-card"
    :class="{ waiting, rejected: request.status === 'rejected' }"
    :aria-label="waiting ? 'Requests waiting for you' : 'Requests'"
  >
    <header>
      <span class="label">{{
        request.requestedBy === 'terminal' ? 'Requests (terminal)' : 'Requests'
      }}</span>
      <span class="summary">{{ decisionSummary(request) }}</span>
    </header>
    <ul>
      <li
        v-for="item in request.items"
        :key="item.id"
        class="item"
        :class="[item.outcome, { left: waiting && selected.get(item.id) === false }]"
        @focusin="focus(item.id)"
        @focusout="focus(null)"
      >
        <div class="line">
          <input
            v-if="waiting"
            type="checkbox"
            :checked="selected.get(item.id) !== false"
            :aria-label="`Approve: ${title(shown(item))}`"
            @change="setSelected(item.id, ($event.target as HTMLInputElement).checked)"
          />
          <span class="what">{{ title(shown(item)) }}</span>
          <span v-if="waiting && editedNow(item).length > 0" class="edited">edited</span>
          <button
            v-if="waiting"
            type="button"
            class="expand"
            :aria-expanded="open.has(item.id)"
            :aria-label="open.has(item.id) ? 'Hide the details' : 'Show and edit the details'"
            @click="open.has(item.id) ? open.delete(item.id) : open.add(item.id)"
          >
            {{ open.has(item.id) ? '▾' : '▸' }}
          </button>
        </div>
        <p v-if="attachesCredential(shown(item))" class="warning">
          Attaches a credential: the fork can read it and use it on the hosts it may reach.
        </p>
        <RequestItemEditor
          v-if="waiting && open.has(item.id)"
          :action="drafts.get(item.id) ?? item.original"
          :forks="otherForks"
          :note-groups="[...noteGroups.values()]"
          :credential-names="credentialNames"
          @update="setDraft(item.id, $event)"
        />
        <template v-if="!waiting">
          <p class="outcome">
            {{ outcomeLabel(item) }}
            <RouterLink v-if="resultLink(item)" :to="resultLink(item)!.to">{{
              resultLink(item)!.label
            }}</RouterLink>
          </p>
          <ul v-if="editedFields(item.original, item.final).length > 0" class="edits">
            <li v-for="field in editedFields(item.original, item.final)" :key="field">
              Edited {{ field }}. Claude asked for: <q>{{ originalValue(item.original, field) }}</q>
            </li>
          </ul>
        </template>
      </li>
    </ul>
    <p v-if="!waiting && request.reason" class="reason">Reason: {{ request.reason }}</p>
    <p v-if="!waiting && request.allowedAreas.length > 0" class="reason">
      With this approval you allowed without asking in this fork:
      {{ allowedRecord }}.
    </p>
    <fieldset v-if="waiting && offeredAreas.length > 0" class="allow">
      <label v-for="area in offeredAreas" :key="area" :class="{ off: !tickedAreas.has(area) }">
        <input
          type="checkbox"
          :checked="allow.has(area)"
          :disabled="!tickedAreas.has(area)"
          @change="setAllowed(area, ($event.target as HTMLInputElement).checked)"
        />
        {{ allowAreaLabel(area) }}
        <span v-if="area === 'forks'" class="muted"> (up to the runner's limit per hour)</span>
      </label>
      <p v-if="allowedNow.length > 0" class="warning">
        Applies when you approve. A fork that reads hostile content, such as a web page or a README,
        could then act without you in these areas.
      </p>
    </fieldset>
    <div v-if="waiting" class="actions">
      <input
        v-model="reason"
        class="reason-input"
        placeholder="Reason for rejecting (optional)"
        aria-label="Reason for rejecting"
        @input="onReasonInput"
        @focus="focus(reasonKey)"
        @blur="focus(null)"
      />
      <ConfirmButton
        label="Reject"
        armed-label="Sure?"
        danger
        :disabled="busy || unreachable"
        :title="unreachable ? notOffline : undefined"
        @confirm="decide('reject')"
      />
      <ConfirmButton
        :label="`Approve ${tickedCount}`"
        armed-label="Sure?"
        class="primary"
        :disabled="busy || unreachable || tickedCount === 0"
        :title="unreachable ? notOffline : undefined"
        @confirm="decide('approve')"
      />
    </div>
    <p v-if="error" class="error" role="alert">{{ error }}</p>
    <p v-if="waiting && unreachable" class="offline-note" role="status">
      Approve and Reject wait for the connection to the daemon. Your edits are kept and sent when it
      is back.
    </p>
  </section>
</template>

<style scoped>
.request-card {
  margin: 0.75rem 0;
  padding: 0.6rem 0.8rem;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--surface);
  font-size: 0.9rem;
  scroll-margin-top: 6rem;
}

.request-card.waiting {
  border: 2px solid var(--caution);
  box-shadow: var(--shadow);
}

header {
  display: flex;
  gap: 0.6rem;
  align-items: baseline;
  margin-bottom: 0.4rem;
}

.label {
  font-size: 0.7rem;
  font-weight: 600;
  letter-spacing: 0.05em;
  text-transform: uppercase;
  color: var(--warning);
}

.summary {
  color: var(--text-muted);
  font-size: 0.8rem;
}

ul {
  list-style: none;
  margin: 0;
  padding: 0;
}

.item {
  padding: 0.3rem 0;
  border-top: 1px solid var(--border);
}

.item:first-child {
  border-top: none;
}

.line {
  display: flex;
  align-items: center;
  gap: 0.5rem;
}

.what {
  flex: 1;
}

.left .what {
  opacity: 0.55;
}

.rejected .what,
.item.rejected .what {
  text-decoration: line-through;
}

.edited {
  font-size: 0.7rem;
  color: var(--accent);
}

.expand {
  padding: 0 0.4rem;
  border: none;
  background: none;
}

.warning {
  margin: 0.2rem 0 0 1.6rem;
  color: var(--danger);
  font-size: 0.8rem;
}

.outcome {
  margin: 0.15rem 0 0;
  font-size: 0.8rem;
  color: var(--text-muted);
}

.item.done .outcome {
  color: var(--success);
}

.item.failed .outcome {
  color: var(--danger);
}

.outcome a {
  margin-left: 0.4rem;
}

.edits {
  margin: 0.15rem 0 0;
  font-size: 0.8rem;
  color: var(--text-muted);
}

.reason {
  margin: 0.4rem 0 0;
  font-size: 0.8rem;
  color: var(--text-muted);
}

.actions {
  display: flex;
  gap: 0.5rem;
  align-items: center;
  margin-top: 0.5rem;
}

.allow {
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
  margin: 0.5rem 0 0;
  padding: 0;
  border: none;
  font-size: 0.85rem;
}

.allow label {
  display: flex;
  align-items: center;
  gap: 0.4rem;
}

.allow .off {
  opacity: 0.55;
}

.allow .warning {
  margin: 0;
}

.offline-note {
  margin: 0.4rem 0 0;
  font-size: 0.8rem;
  color: var(--text-muted);
}

.reason-input {
  flex: 1;
  min-width: 0;
  font: inherit;
  font-size: 0.85rem;
}

.error {
  color: var(--danger);
  margin: 0.4rem 0 0;
}
</style>
