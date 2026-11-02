import { onBeforeUnmount, ref, type Ref } from 'vue';

interface Slot {
  id: string;
  top: number;
  height: number;
}

const edgePx = 56;
const maxScrollStepPx = 16;

const pageTop = (element: Element) => element.getBoundingClientRect().top + window.scrollY;

// Drags one item of a vertical list by its handle, with the pointer, so it works with touch too.
// Items carry `data-drag-id`; the dragged one follows the pointer and a line shows where it lands.
// The page scrolls while the pointer is near the top or bottom edge.
export function useDragSort(options: {
  container: Ref<HTMLElement | null>;
  range: (itemId: string) => { first: number; last: number };
  onDrop: (itemId: string, index: number) => void;
}) {
  const draggedId = ref<string | null>(null);
  const offset = ref(0);
  const indicatorTop = ref<number | null>(null);
  let dragged: Slot | null = null;
  let others: Slot[] = [];
  let index = 0;
  let clientY = 0;
  let startPageY = 0;
  let frame = 0;
  let handle: HTMLElement | null = null;

  function update() {
    const container = options.container.value;
    if (!dragged || !container) return;
    offset.value = clientY + window.scrollY - startPageY;
    const middle = dragged.top + offset.value + dragged.height / 2;
    const passed = others.filter((slot) => slot.top + slot.height / 2 < middle).length;
    const { first, last } = options.range(dragged.id);
    index = Math.min(Math.max(passed, first), last);
    const next = others[index];
    const previous = others[index - 1];
    const lineTop = next ? next.top : previous ? previous.top + previous.height : dragged.top;
    indicatorTop.value = lineTop - pageTop(container);
  }

  function scrollNearEdges() {
    const top = document.querySelector('[data-sticky-header]')?.getBoundingClientRect().bottom ?? 0;
    const bottom = window.visualViewport?.height ?? window.innerHeight;
    const intoTop = top + edgePx - clientY;
    const intoBottom = clientY - (bottom - edgePx);
    const step =
      intoTop > 0
        ? -maxScrollStepPx * Math.min(1, intoTop / edgePx)
        : intoBottom > 0
          ? maxScrollStepPx * Math.min(1, intoBottom / edgePx)
          : 0;
    if (step !== 0) {
      window.scrollBy(0, step);
      update();
    }
    frame = requestAnimationFrame(scrollNearEdges);
  }

  function onMove(event: PointerEvent) {
    clientY = event.clientY;
    update();
  }

  const onUp = () => finish(true);
  const onCancel = () => finish(false);

  function finish(drop: boolean) {
    cancelAnimationFrame(frame);
    handle?.removeEventListener('pointermove', onMove);
    handle?.removeEventListener('pointerup', onUp);
    handle?.removeEventListener('pointercancel', onCancel);
    const itemId = draggedId.value;
    handle = null;
    dragged = null;
    others = [];
    draggedId.value = null;
    offset.value = 0;
    indicatorTop.value = null;
    if (drop && itemId) options.onDrop(itemId, index);
  }

  function start(event: PointerEvent, itemId: string) {
    const container = options.container.value;
    if (!container || event.button !== 0 || !(event.currentTarget instanceof HTMLElement)) return;
    const slots = [...container.querySelectorAll<HTMLElement>('[data-drag-id]')].map((element) => ({
      id: element.dataset.dragId!,
      top: pageTop(element),
      height: element.offsetHeight,
    }));
    dragged = slots.find((slot) => slot.id === itemId) ?? null;
    if (!dragged) return;
    event.preventDefault();
    others = slots.filter((slot) => slot.id !== itemId);
    handle = event.currentTarget;
    handle.setPointerCapture(event.pointerId);
    handle.addEventListener('pointermove', onMove);
    handle.addEventListener('pointerup', onUp);
    handle.addEventListener('pointercancel', onCancel);
    clientY = event.clientY;
    startPageY = clientY + window.scrollY;
    draggedId.value = itemId;
    update();
    frame = requestAnimationFrame(scrollNearEdges);
  }

  onBeforeUnmount(() => {
    if (draggedId.value) finish(false);
  });

  return { draggedId, offset, indicatorTop, start };
}
