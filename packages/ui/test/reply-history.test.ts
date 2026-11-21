import { expect, it } from 'vitest';
import { atDraft, stepBack, stepForward } from '../src/lib/reply-history';

const sent = ['First', 'Second', 'Third'];

it('goes back one message at a time, newest first, and stops at the oldest', () => {
  const first = stepBack(sent, atDraft(), 'Half typed')!;
  expect(first.text).toBe('Third');
  const second = stepBack(sent, first.history, first.text)!;
  expect(second.text).toBe('Second');
  const third = stepBack(sent, second.history, second.text)!;
  expect(third.text).toBe('First');
  expect(stepBack(sent, third.history, third.text)).toBeNull();
});

it('goes forward again and ends on what was being typed', () => {
  const back = stepBack(sent, atDraft(), 'Half typed')!;
  const further = stepBack(sent, back.history, back.text)!;
  const forward = stepForward(sent, further.history)!;
  expect(forward.text).toBe('Third');
  const draft = stepForward(sent, forward.history)!;
  expect(draft).toEqual({ history: atDraft(), text: 'Half typed' });
  expect(stepForward(sent, draft.history)).toBeNull();
});

it('does nothing in a fork with no message sent', () => {
  expect(stepBack([], atDraft(), '')).toBeNull();
  expect(stepForward([], atDraft())).toBeNull();
});
