import { onBeforeUnmount, onMounted, ref } from 'vue';

const commentFields = '.comment-editor textarea, .comment-card textarea';

const isCommentField = (target: EventTarget | null) =>
  target instanceof HTMLElement && target.matches(commentFields);

// Whether the reader is typing a comment, in a new one's editor or editing a card.
export function useCommentTyping() {
  const typing = ref(false);
  const onFocusIn = (event: FocusEvent) => (typing.value = isCommentField(event.target));
  const onFocusOut = (event: FocusEvent) => (typing.value = isCommentField(event.relatedTarget));
  onMounted(() => {
    document.addEventListener('focusin', onFocusIn);
    document.addEventListener('focusout', onFocusOut);
  });
  onBeforeUnmount(() => {
    document.removeEventListener('focusin', onFocusIn);
    document.removeEventListener('focusout', onFocusOut);
  });
  return typing;
}
