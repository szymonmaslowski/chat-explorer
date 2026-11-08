import { onBeforeUnmount, onMounted, ref } from 'vue';

const commentFields = '.comment-editor textarea, .comment-card textarea';
// Showing the reply box again moves the page, so it waits until a tap that left the comment, on
// its Save button for one, has landed.
const settleMs = 300;
const listenedEvents = ['focusout', 'click', 'keydown'] as const;

const isCommentField = (target: EventTarget | null) =>
  target instanceof HTMLElement && target.matches(commentFields);

// Whether the reader is typing a comment, in a new one's editor or editing a card.
export function useCommentTyping() {
  const typing = ref(false);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const check = () => (typing.value = isCommentField(document.activeElement));
  const checkLater = () => {
    clearTimeout(timer);
    timer = setTimeout(check, settleMs);
  };
  const onFocusIn = (event: FocusEvent) => {
    if (!isCommentField(event.target)) return checkLater();
    clearTimeout(timer);
    typing.value = true;
  };
  onMounted(() => {
    document.addEventListener('focusin', onFocusIn);
    for (const type of listenedEvents) document.addEventListener(type, checkLater, true);
  });
  onBeforeUnmount(() => {
    clearTimeout(timer);
    document.removeEventListener('focusin', onFocusIn);
    for (const type of listenedEvents) document.removeEventListener(type, checkLater, true);
  });
  return typing;
}
