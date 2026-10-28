// Where the middle of the block being read sits, as a share of the visible height: a little
// above the centre, so more of what comes next shows below it than what came before above it.
const readingLine = 0.4;
// A block taller than this share of the visible height starts at the top instead.
const tallBlockShare = 0.6;
const topMarginPx = 16;

export function bringToReadingLine(element: HTMLElement) {
  const header = document.querySelector('[data-sticky-header]');
  const dock = document.querySelector('[data-dock]');
  const visibleTop = header ? header.getBoundingClientRect().bottom : 0;
  const visibleBottom = dock ? dock.getBoundingClientRect().top : window.innerHeight;
  const visibleHeight = visibleBottom - visibleTop;
  const box = element.getBoundingClientRect();
  const targetTop =
    box.height > visibleHeight * tallBlockShare
      ? visibleTop + topMarginPx
      : visibleTop + visibleHeight * readingLine - box.height / 2;
  window.scrollBy({ top: box.top - targetTop, behavior: 'smooth' });
}
