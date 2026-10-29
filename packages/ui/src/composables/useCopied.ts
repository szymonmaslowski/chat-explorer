import { onBeforeUnmount, ref } from 'vue';
import { copyToClipboard, type ClipboardText } from '../lib/clipboard';

const confirmMs = 1_500;

// A copy button shows a check mark for a moment after copying.
export function useCopied() {
  const copied = ref(false);
  let resetTimer: ReturnType<typeof setTimeout> | undefined;

  async function copy(text: ClipboardText) {
    await copyToClipboard(text);
    copied.value = true;
    clearTimeout(resetTimer);
    resetTimer = setTimeout(() => (copied.value = false), confirmMs);
  }

  onBeforeUnmount(() => clearTimeout(resetTimer));
  return { copied, copy };
}
