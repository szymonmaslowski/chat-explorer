const flashMs = 1_400;

export function scrollToAndFlash(element: HTMLElement) {
  element.scrollIntoView({ behavior: 'smooth', block: 'center' });
  element.classList.add('flash');
  setTimeout(() => element.classList.remove('flash'), flashMs);
}
