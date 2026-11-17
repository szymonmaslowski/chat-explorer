import { onBeforeUnmount, onMounted, type Ref } from 'vue';

// Keeps the height of the page's sticky header in `--sticky-header-height` on the page, for what
// sticks just under it. The header grows when its title wraps.
export function useStickyHeaderHeight(page: Ref<HTMLElement | null>) {
  let observer: ResizeObserver | null = null;
  onMounted(() => {
    const header = page.value?.querySelector<HTMLElement>('[data-sticky-header]');
    if (!header) return;
    observer = new ResizeObserver(() =>
      page.value?.style.setProperty('--sticky-header-height', `${header.offsetHeight}px`),
    );
    observer.observe(header);
  });
  onBeforeUnmount(() => observer?.disconnect());
}
