import type { Exploration } from '../shared/types.js';

export function postCompactOutput(exploration: Exploration | null) {
  if (!exploration) return null;
  const name = exploration.title ? ` ("${exploration.title}")` : '';
  return {
    hookSpecificOutput: {
      hookEventName: 'SessionStart',
      additionalContext: [
        `This session is attached to chat-explorer exploration ${exploration.id}${name}, and the conversation was just compacted.`,
        'Before answering in it, call get_map, then read_fork for each fork you answer, and answer only from that fork.',
        'Then continue the /explore-chat loop: call await_feedback, answer with add_message, and call await_feedback again.',
      ].join(' '),
    },
  };
}
