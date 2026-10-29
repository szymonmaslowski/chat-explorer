import type { Comment } from '@shared/types';
import { expect, it, vi } from 'vitest';
import type { ExplorationState } from '../src/stores/exploration';

vi.mock('../src/api', async (importOriginal) => {
  const { ApiError } = await importOriginal<typeof import('../src/api')>();
  const unreachable = () => Promise.reject(new TypeError('Failed to fetch'));
  return {
    ApiError,
    api: { createComment: unreachable, updateComment: unreachable, snapshot: unreachable },
  };
});

const { applyServerEvent } = await import('../src/stores/exploration');
const { outbox } = await import('../src/stores/outbox');

it('keeps a Save made here when the older "created" notice arrives after it', () => {
  const explorationId = 'e';
  const anchor = { messageId: 'm', viewForkId: 'f', quote: 'q', startOffset: 0, endOffset: 1 };
  const state = { explorationId, comments: new Map<string, Comment>() } as ExplorationState;
  outbox.add({
    type: 'comment.create',
    explorationId,
    comment: { id: 'c000000001', ...anchor, body: '', editBody: 'Half' },
  });
  outbox.add({
    type: 'comment.update',
    explorationId,
    commentId: 'c000000001',
    changes: { body: 'Whole', editBody: null },
  });

  const created: Comment = {
    id: 'c000000001',
    explorationId,
    ...anchor,
    body: '',
    editBody: 'Half',
    type: 'inline',
    status: 'draft',
    submissionId: null,
    replyMessageId: null,
    createdForkId: null,
    createdAt: 0,
    updatedAt: 0,
  };
  applyServerEvent(state, { type: 'comment.created', comment: created });
  expect(state.comments.get('c000000001')).toMatchObject({ body: 'Whole', editBody: null });
});
