import { api } from '../api';
import { applyReadChange, type ExplorationState } from './exploration';

// Shown read at once; if the daemon cannot be reached, the next load shows them unread again
// and they are marked once more when seen.
export function markRead(state: ExplorationState, messageIds: string[]) {
  applyReadChange(state, messageIds, Date.now());
  void api.markRead(state.explorationId, messageIds).catch(() => undefined);
}

export async function markUnreadFrom(
  state: ExplorationState,
  messageId: string,
  viewForkId: string,
) {
  const change = await api.markUnreadFrom(messageId, viewForkId);
  applyReadChange(state, change.messageIds, change.readAt);
}
