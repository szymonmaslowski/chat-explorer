import type { ExplorationEvent } from '../shared/types.js';

type Listener = (explorationId: string, event: ExplorationEvent) => void;

export class EventBus {
  private readonly listeners = new Set<Listener>();

  publish(explorationId: string, event: ExplorationEvent) {
    for (const listener of this.listeners) listener(explorationId, event);
  }

  subscribe(listener: Listener) {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  subscribeTo(explorationId: string, listener: (event: ExplorationEvent) => void) {
    return this.subscribe((eventExplorationId, event) => {
      if (eventExplorationId === explorationId) listener(event);
    });
  }
}
