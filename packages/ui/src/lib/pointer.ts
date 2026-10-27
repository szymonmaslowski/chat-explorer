import { reactive } from 'vue';

const offscreen = -100_000;

// `frame` also advances on scroll, because element rects move under a cursor that stays still.
export const pointer = reactive({ x: offscreen, y: offscreen, frame: 0 });

let latest = { x: offscreen, y: offscreen };
let scheduled = false;

const schedule = () => {
  if (scheduled) return;
  scheduled = true;
  requestAnimationFrame(() => {
    scheduled = false;
    pointer.x = latest.x;
    pointer.y = latest.y;
    pointer.frame += 1;
  });
};

window.addEventListener(
  'mousemove',
  (event) => {
    latest = { x: event.clientX, y: event.clientY };
    schedule();
  },
  { passive: true },
);
window.addEventListener('scroll', schedule, { passive: true });
window.addEventListener('resize', schedule, { passive: true });
document.documentElement.addEventListener('mouseleave', () => {
  latest = { x: offscreen, y: offscreen };
  schedule();
});
