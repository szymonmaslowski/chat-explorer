import { computed, ref, watch, type Ref } from 'vue';
import {
  defaultColumnWidths,
  readColumnWidths,
  storeColumnWidths,
  type ColumnWidths,
  type ResizableColumn,
} from '../lib/column-widths';

// The narrowest each column may be dragged to, in pixels: the chats keep room for their cards and
// the open page for a readable line.
const minimumWidths = { chats: 224, map: 256, main: 448 };

// The desktop columns' widths for the open chat, and dragging their edges.
export function useColumnWidths(input: {
  explorationId: Ref<string | null>;
  mapColumn: Ref<boolean>;
  layout: Ref<HTMLElement | null>;
  columns: Record<ResizableColumn, Ref<HTMLElement | null>>;
}) {
  const widths = ref<ColumnWidths>(defaultColumnWidths);
  watch(
    input.explorationId,
    (explorationId) => {
      widths.value = explorationId ? readColumnWidths(explorationId) : defaultColumnWidths;
    },
    { immediate: true },
  );

  const save = () => {
    if (input.explorationId.value) storeColumnWidths(input.explorationId.value, widths.value);
  };

  // Moves the column's right edge to a point on the page, leaving the columns after it their room.
  function moveEdge(column: ResizableColumn, clientX: number) {
    const layout = input.layout.value;
    const element = input.columns[column].value;
    if (!layout || !element) return;
    const total = layout.clientWidth;
    const left = element.getBoundingClientRect().left;
    const offset = left - layout.getBoundingClientRect().left;
    const after =
      column === 'chats' && input.mapColumn.value
        ? minimumWidths.map + minimumWidths.main
        : minimumWidths.main;
    const width = Math.min(Math.max(clientX - left, minimumWidths[column]), total - offset - after);
    widths.value = { ...widths.value, [column]: width / total };
  }

  function step(column: ResizableColumn, pixels: number) {
    const element = input.columns[column].value;
    if (element) moveEdge(column, element.getBoundingClientRect().right + pixels);
  }

  function reset(column: ResizableColumn) {
    widths.value = { ...widths.value, [column]: null };
    save();
  }

  const columnStyle = (column: ResizableColumn) => {
    const share = widths.value[column];
    return share === null
      ? undefined
      : { flex: `0 1 ${share * 100}%`, minWidth: `${minimumWidths[column]}px` };
  };
  const styles = computed(() => ({
    chats: columnStyle('chats'),
    map: columnStyle('map'),
    // Beside a map of a chosen width, the open page takes what is left instead of half.
    main: input.mapColumn.value && widths.value.map !== null ? { flex: '1 1 0' } : undefined,
  }));

  // The share each column has now, for the dividers to announce.
  const percent = (column: ResizableColumn) => {
    const share = widths.value[column];
    if (share !== null) return share * 100;
    const layout = input.layout.value;
    const element = input.columns[column].value;
    return layout && element ? (element.offsetWidth / layout.clientWidth) * 100 : 0;
  };

  return { styles, moveEdge, step, reset, save, percent };
}
