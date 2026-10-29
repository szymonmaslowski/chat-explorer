import { computed, onBeforeUnmount, ref, watch, type Ref } from 'vue';

interface Area {
  top: number;
  bottom: number;
  left: number;
  width: number;
}

// The free space between the sticky header and the dock, or down to the bottom of the screen for
// the dock itself. A phone keyboard shrinks the visual viewport, so the area stays above it.
export function useExpandedArea(
  expanded: Ref<boolean>,
  options: { coverDock: boolean; marginPx: number },
) {
  const area = ref<Area | null>(null);

  function measure() {
    const header = document.querySelector('[data-sticky-header]')?.getBoundingClientRect();
    const dock = document.querySelector('[data-dock]')?.getBoundingClientRect();
    const viewport = window.visualViewport;
    const visibleTop = viewport?.offsetTop ?? 0;
    const visibleBottom = visibleTop + (viewport?.height ?? window.innerHeight);
    const bottom = options.coverDock || !dock ? visibleBottom : dock.top;
    area.value = {
      top: Math.max(header?.bottom ?? 0, visibleTop),
      bottom: Math.min(bottom, visibleBottom),
      left: dock?.left ?? 0,
      width: dock?.width ?? window.innerWidth,
    };
  }

  const resizeObserver = new ResizeObserver(measure);
  const viewportEvents = ['resize', 'scroll'] as const;

  function start() {
    measure();
    for (const selector of ['[data-sticky-header]', '[data-dock]']) {
      const element = document.querySelector(selector);
      if (element) resizeObserver.observe(element);
    }
    for (const event of viewportEvents) {
      window.addEventListener(event, measure, { passive: true });
      window.visualViewport?.addEventListener(event, measure);
    }
  }

  function stop() {
    resizeObserver.disconnect();
    for (const event of viewportEvents) {
      window.removeEventListener(event, measure);
      window.visualViewport?.removeEventListener(event, measure);
    }
    area.value = null;
  }

  watch(expanded, (isExpanded) => (isExpanded ? start() : stop()), { immediate: true });
  onBeforeUnmount(stop);

  return computed(() => {
    if (!expanded.value || !area.value) return null;
    const { top, bottom, left, width } = area.value;
    const margin = options.marginPx;
    return {
      position: 'fixed' as const,
      top: `${top + margin}px`,
      left: `${left}px`,
      width: `${width}px`,
      height: `${Math.max(bottom - top - 2 * margin, 0)}px`,
    };
  });
}
