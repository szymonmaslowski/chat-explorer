<script setup lang="ts">
import { usePopover } from '../composables/usePopover';
import MediaIcon from './MediaIcon.vue';

const emit = defineEmits<{ show: []; hide: [] }>();
const { open, closeOnEscape } = usePopover('root');

function choose(action: 'show' | 'hide') {
  open.value = false;
  if (action === 'show') emit('show');
  else emit('hide');
}
</script>

<template>
  <div ref="root" class="drop-up" @keydown.escape="closeOnEscape">
    <div v-if="open" class="drop-up-menu from-right" role="menu" aria-label="Drafts">
      <button type="button" role="menuitem" @click="choose('show')">Show all drafts</button>
      <button type="button" role="menuitem" @click="choose('hide')">Hide all drafts</button>
    </div>
    <button
      type="button"
      class="toggle"
      aria-haspopup="menu"
      :aria-expanded="open"
      aria-label="Drafts"
      title="Show or hide the drafts in the text"
      @click="open = !open"
    >
      <MediaIcon name="eye" />
      <MediaIcon name="chevron-up" />
    </button>
  </div>
</template>

<style scoped>
.toggle {
  display: inline-flex;
  align-items: center;
  gap: 0.3rem;
  padding: 0.15rem 0.4rem;
}

.drop-up-menu button {
  white-space: nowrap;
  text-align: left;
}
</style>
