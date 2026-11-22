const settleMs = 1_500;
const readerScrollEvents = ['wheel', 'touchstart', 'keydown', 'mousedown'] as const;

// Comment cards, images and fonts still change the page's height after the first render, so the
// page keeps scrolling to its target until it settles or the reader scrolls.
export function holdScroll(target: () => number) {
  const observer = new ResizeObserver(() => window.scrollTo({ top: target() }));
  const release = () => {
    observer.disconnect();
    clearTimeout(timer);
    for (const type of readerScrollEvents) window.removeEventListener(type, release);
  };
  const timer = setTimeout(release, settleMs);
  for (const type of readerScrollEvents) window.addEventListener(type, release, { passive: true });
  observer.observe(document.body);
}
