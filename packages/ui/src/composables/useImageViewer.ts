import { computed } from 'vue';
import { useRoute, useRouter } from 'vue-router';

const fileUrlPattern = /^\/api\/files\/([a-z0-9]+)$/;

export function fileIdOfImage(source: string) {
  return new URL(source, window.location.origin).pathname.match(fileUrlPattern)?.[1] ?? null;
}

// The open image lives in the address, so the phone's back gesture closes it like a page.
export function useImageViewer() {
  const route = useRoute();
  const router = useRouter();
  const openFileId = computed(() =>
    typeof route.query.image === 'string' ? route.query.image : null,
  );

  function open(fileId: string) {
    void router.push({ query: { ...route.query, image: fileId } });
  }

  // Opened from a page of this app, back returns to it; opened from a link, there is nothing to
  // go back to, so the image is taken out of the address instead.
  function close() {
    const previous: string | undefined = window.history.state?.back;
    if (previous && !previous.includes('image=')) {
      router.back();
      return;
    }
    const query = { ...route.query };
    delete query.image;
    void router.replace({ query, hash: route.hash });
  }

  return { openFileId, open, close };
}
