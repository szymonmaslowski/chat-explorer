import { holdScroll } from './hold-scroll';

const flashMs = 1_400;

// Not a smooth scroll: it is computed once, and cards, images and older messages that settle
// afterwards would leave it short of the target.
export function scrollToAndFlash(
  element: HTMLElement,
  align: 'center' | 'below-header' = 'center',
) {
  const target = () => {
    const { top, height } = element.getBoundingClientRect();
    if (align === 'below-header') {
      const header = document.querySelector<HTMLElement>('[data-sticky-header]');
      return Math.max(0, window.scrollY + top - (header?.offsetHeight ?? 0) - 8);
    }
    return Math.max(0, window.scrollY + top - (window.innerHeight - height) / 2);
  };
  window.scrollTo({ top: target() });
  holdScroll(target);
  element.classList.add('flash');
  setTimeout(() => element.classList.remove('flash'), flashMs);
}
