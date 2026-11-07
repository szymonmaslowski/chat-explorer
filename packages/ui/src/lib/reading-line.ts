// Where the middle of the block being read sits, as a share of the visible height: a little
// above the centre, so more of what comes next shows below it than what came before above it.
const readingLine = 0.4;
// A block taller than this share of the visible height starts at the top instead.
const tallBlockShare = 0.6;
const topMarginPx = 16;

// The part of the window between the sticky header and the dock.
export function visibleArea() {
  const header = document.querySelector('[data-sticky-header]');
  const dock = document.querySelector('[data-dock]');
  const top = header ? header.getBoundingClientRect().bottom : 0;
  const bottom = dock ? dock.getBoundingClientRect().top : window.innerHeight;
  return { top, bottom };
}

export function bringToReadingLine(element: HTMLElement) {
  const { top: visibleTop, bottom: visibleBottom } = visibleArea();
  const visibleHeight = visibleBottom - visibleTop;
  const box = element.getBoundingClientRect();
  const targetTop =
    box.height > visibleHeight * tallBlockShare
      ? visibleTop + topMarginPx
      : visibleTop + visibleHeight * readingLine - box.height / 2;
  window.scrollBy({ top: box.top - targetTop, behavior: 'smooth' });
}

function distanceToEdge(element: HTMLElement, edge: 'start' | 'end') {
  const { top, bottom } = visibleArea();
  const box = element.getBoundingClientRect();
  return edge === 'start' ? box.top - top - topMarginPx : box.bottom - bottom + topMarginPx;
}

// Brings the start of the element just under the header, or its end just above the dock.
export function scrollToEdge(element: HTMLElement, edge: 'start' | 'end') {
  window.scrollBy({ top: distanceToEdge(element, edge), behavior: 'smooth' });
}

// The page scroll position that brings the start of the element just under the header.
export const scrollTopAtStartOf = (element: HTMLElement) =>
  window.scrollY + distanceToEdge(element, 'start');
