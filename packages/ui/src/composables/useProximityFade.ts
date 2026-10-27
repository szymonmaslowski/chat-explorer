import { computed, onBeforeUnmount, ref, watch, type Ref } from 'vue';
import { pointer } from '../lib/pointer';

const fadeDistance = 80;
const minimumOpacity = 0.2;
const revealAfterMs = 1_500;

export function distanceToRect(rect: DOMRect, x: number, y: number) {
  const dx = Math.max(rect.left - x, 0, x - rect.right);
  const dy = Math.max(rect.top - y, 0, y - rect.bottom);
  return Math.hypot(dx, dy);
}

export function opacityAt(distance: number) {
  if (distance >= fadeDistance) return 1;
  return minimumOpacity + ((1 - minimumOpacity) * distance) / fadeDistance;
}

// Fades an element as the cursor approaches, so the text it covers can be read and selected.
// Holding the cursor over it brings it back until the cursor leaves.
export function useProximityFade(element: Ref<HTMLElement | null>, alwaysOpaque: Ref<boolean>) {
  const faded = ref(1);
  const revealed = ref(false);
  let revealTimer: ReturnType<typeof setTimeout> | null = null;

  const stopTimer = () => {
    if (revealTimer) clearTimeout(revealTimer);
    revealTimer = null;
  };

  watch(
    () => pointer.frame,
    () => {
      if (!element.value) return;
      const distance = distanceToRect(element.value.getBoundingClientRect(), pointer.x, pointer.y);
      faded.value = opacityAt(distance);
      if (distance > 0) {
        stopTimer();
        revealed.value = false;
        return;
      }
      if (!revealed.value && !revealTimer) {
        revealTimer = setTimeout(() => {
          revealTimer = null;
          revealed.value = true;
        }, revealAfterMs);
      }
    },
  );

  onBeforeUnmount(stopTimer);

  const opaque = computed(() => alwaysOpaque.value || revealed.value);
  return {
    opacity: computed(() => (opaque.value ? 1 : faded.value)),
    interactive: computed(() => opaque.value || faded.value === 1),
  };
}
