import { ref, watch } from 'vue';

export const themes = ['system', 'light', 'dark'] as const;
export type Theme = (typeof themes)[number];

const storageKey = 'chat-explorer.theme';

export const theme = ref(readStoredTheme());

function readStoredTheme() {
  try {
    const stored = localStorage.getItem(storageKey);
    return themes.find((candidate) => candidate === stored) ?? 'system';
  } catch {
    return 'system';
  }
}

function applyTheme() {
  document.documentElement.dataset.theme = theme.value;
  // The theme-color tags only follow the system scheme through their media queries.
  const background = getComputedStyle(document.body).backgroundColor;
  for (const meta of document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]')) {
    meta.content = background;
  }
}

watch(theme, (value) => {
  try {
    localStorage.setItem(storageKey, value);
  } catch {}
  applyTheme();
});
window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', applyTheme);
applyTheme();
