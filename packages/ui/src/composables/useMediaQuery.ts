import { onBeforeUnmount, ref } from 'vue';

export function useMediaQuery(query: string) {
  const list = window.matchMedia(query);
  const matches = ref(list.matches);
  const update = () => {
    matches.value = list.matches;
  };
  list.addEventListener('change', update);
  onBeforeUnmount(() => list.removeEventListener('change', update));
  return matches;
}
