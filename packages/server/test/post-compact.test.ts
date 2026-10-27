import { describe, expect, it } from 'vitest';
import { postCompactOutput } from '../src/hooks/post-compact.js';

describe('postCompactOutput', () => {
  it('reminds Claude of the attached exploration', () => {
    const output = postCompactOutput({
      id: 'abc',
      title: 'Caching',
      summary: '',
      model: 'sonnet',
      createdAt: 0,
      updatedAt: 0,
      archivedAt: null,
      deletedAt: null,
    });
    expect(output?.hookSpecificOutput.hookEventName).toBe('SessionStart');
    expect(output?.hookSpecificOutput.additionalContext).toContain('exploration abc ("Caching")');
    expect(output?.hookSpecificOutput.additionalContext).toContain('await_feedback');
  });

  it('prints nothing when the session has no exploration', () => {
    expect(postCompactOutput(null)).toBeNull();
  });
});
