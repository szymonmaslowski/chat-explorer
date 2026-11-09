import { onBeforeUnmount, ref, useTemplateRef, watch } from 'vue';

// A menu or panel opened by a button that closes on a pick, a tap outside or Escape. `rootRef`
// names the template ref of the element holding both.
export function usePopover(rootRef: string) {
  const open = ref(false);
  const root = useTemplateRef<HTMLElement>(rootRef);

  // Escape closes only the menu, not the editor or dialog around it.
  function closeOnEscape(event: KeyboardEvent) {
    if (!open.value) return;
    event.stopPropagation();
    open.value = false;
  }

  function closeOutside(event: PointerEvent) {
    if (event.target instanceof Node && !root.value?.contains(event.target)) open.value = false;
  }

  watch(open, (isOpen) => {
    if (isOpen) document.addEventListener('pointerdown', closeOutside);
    else document.removeEventListener('pointerdown', closeOutside);
  });
  onBeforeUnmount(() => document.removeEventListener('pointerdown', closeOutside));

  return { open, closeOnEscape };
}
