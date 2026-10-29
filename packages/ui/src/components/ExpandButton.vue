<script setup lang="ts">
import MediaIcon from './MediaIcon.vue';

const expanded = defineModel<boolean>({ required: true });
</script>

<template>
  <!-- Keeps the focus in the text box, so a phone keeps its keyboard up. -->
  <button
    type="button"
    class="expand-button"
    :aria-label="expanded ? 'Shrink' : 'Expand'"
    :title="expanded ? 'Shrink' : 'Expand to the free space'"
    @pointerdown.prevent
    @mousedown.prevent
    @click="expanded = !expanded"
  >
    <MediaIcon :name="expanded ? 'shrink' : 'expand'" />
  </button>
</template>

<style scoped>
.expand-button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
}
</style>
