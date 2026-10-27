<script setup lang="ts">
import { theme, themes, type Theme } from '../lib/theme';

const labels: Record<Theme, string> = { system: 'System', light: 'Light', dark: 'Dark' };
const icons: Record<Theme, string> = { system: '◐', light: '☀︎', dark: '☾' };

function next() {
  theme.value = themes[(themes.indexOf(theme.value) + 1) % themes.length]!;
}
</script>

<template>
  <button
    type="button"
    class="theme-switch"
    :title="`Theme: ${labels[theme]}`"
    :aria-label="`Theme: ${labels[theme]}`"
    @click="next"
  >
    {{ icons[theme] }}
  </button>
</template>

<style scoped>
.theme-switch {
  flex: none;
  width: 1.9rem;
  padding: 0.15rem 0;
  font-size: 0.95rem;
  line-height: 1.2;
}

@media (pointer: coarse) {
  .theme-switch {
    font-size: 1.2rem;
  }
}
</style>
