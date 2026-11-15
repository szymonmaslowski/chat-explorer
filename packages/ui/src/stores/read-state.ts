import { outbox } from './outbox';
import { applyReadChange, type ExplorationState } from './exploration';

// Shown at once and sent through the outbox, offline too, with the time the reader acted.
export function markRead(state: ExplorationState, messageIds: string[]) {
  applyReadChange(state, messageIds, Date.now());
  outbox.add({
    type: 'messages.read',
    explorationId: state.explorationId,
    messageIds,
    at: Date.now(),
  });
}

export function markUnreadFrom(state: ExplorationState, messageId: string, viewForkId: string) {
  outbox.add({
    type: 'messages.unread',
    explorationId: state.explorationId,
    messageId,
    viewForkId,
    at: Date.now(),
  });
}
