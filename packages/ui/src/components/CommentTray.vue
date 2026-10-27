<script setup lang="ts">
import type { Comment } from '@shared/types';
import { computed, ref } from 'vue';

const props = defineProps<{ comments: Comment[] }>();
const emit = defineEmits<{ jump: [commentId: string] }>();

const visibleCount = 3;
const expanded = ref(false);
const shown = computed(() =>
  expanded.value ? props.comments : props.comments.slice(0, visibleCount),
);
const hiddenCount = computed(() => props.comments.length - shown.value.length);
</script>

<template>
  <div v-if="comments.length" class="tray">
    <button
      v-for="comment in shown"
      :key="comment.id"
      type="button"
      class="chip"
      :class="comment.type"
      :title="comment.body"
      @click="emit('jump', comment.id)"
    >
      {{ comment.body }}
    </button>
    <button v-if="hiddenCount > 0" type="button" class="more" @click="expanded = true">
      +{{ hiddenCount }}
    </button>
    <button v-else-if="expanded" type="button" class="more" @click="expanded = false">Less</button>
  </div>
</template>

<style scoped>
.tray {
  display: flex;
  flex-wrap: wrap;
  gap: 0.35rem;
  padding: 0.4rem 0;
}

.chip {
  max-width: 14rem;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  border-color: var(--accent);
  background: var(--accent-soft);
  font-size: 0.8rem;
  padding: 0.15rem 0.6rem;
  border-radius: 999px;
}

.chip.fork {
  border-color: var(--fork);
  background: var(--fork-soft);
}

.more {
  font-size: 0.8rem;
  padding: 0.15rem 0.6rem;
  border-radius: 999px;
}
</style>
