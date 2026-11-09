import { computed } from 'vue';
import { useRoute } from 'vue-router';
import { useMediaQuery } from './useMediaQuery';

export type LayoutPage = 'chats' | 'map' | 'notes' | 'fork';

// A wide screen keeps the chats list beside an open chat, and a medium one the map beside an open
// fork. The page the URL names takes the rest; narrower screens show only that page.
export function useLayout() {
  const route = useRoute();
  const wide = useMediaQuery('(min-width: 1600px)');
  const medium = useMediaQuery('(min-width: 1200px)');
  const explorationId = computed(() => {
    const id = route.params.explorationId;
    return typeof id === 'string' ? id : null;
  });
  const page = computed<LayoutPage>(() => {
    if (!explorationId.value) return 'chats';
    if (route.path.endsWith('/map')) return 'map';
    if (route.path.endsWith('/notes')) return 'notes';
    return 'fork';
  });
  const chatsColumn = computed(() => wide.value && page.value !== 'chats');
  const mapColumn = computed(() => medium.value && page.value === 'fork');
  return { explorationId, page, chatsColumn, mapColumn };
}
