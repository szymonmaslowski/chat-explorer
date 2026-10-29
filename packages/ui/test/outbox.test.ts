import { beforeEach, describe, expect, it, vi } from 'vitest';

const requests: { call: string; args: unknown[] }[] = [];
let answer: () => Promise<unknown> = async () => ({});

vi.mock('../src/api', async (importOriginal) => {
  const { ApiError } = await importOriginal<typeof import('../src/api')>();
  const record =
    (call: string) =>
    (...args: unknown[]) => {
      requests.push({ call, args });
      return answer();
    };
  return {
    ApiError,
    api: {
      createComment: record('createComment'),
      updateComment: record('updateComment'),
      deleteComment: record('deleteComment'),
      saveReplyDraft: record('saveReplyDraft'),
      submit: record('submit'),
      cancelSubmission: record('cancelSubmission'),
    },
  };
});

const { ApiError } = await import('../src/api');

async function freshOutbox() {
  vi.resetModules();
  return (await import('../src/stores/outbox')).outbox;
}

const comment = {
  id: 'c000000001',
  messageId: 'm',
  viewForkId: 'f',
  quote: 'quote',
  startOffset: 0,
  endOffset: 5,
  body: '',
  editBody: 'Half',
};
const explorationId = 'e';

beforeEach(() => {
  localStorage.clear();
  requests.length = 0;
  answer = async () => ({});
});

describe('outbox', () => {
  it('sends changes in the order they were made', async () => {
    const outbox = await freshOutbox();
    outbox.add({ type: 'comment.create', explorationId, comment });
    outbox.add({
      type: 'reply-draft.save',
      explorationId,
      forkId: 'f',
      draft: { text: 'x', newFork: false, fileIds: [] },
    });
    await outbox.flush();
    expect(requests.map(({ call }) => call)).toEqual(['createComment', 'saveReplyDraft']);
    expect(outbox.changes.value).toEqual([]);
  });

  it('keeps changes while the daemon cannot be reached and folds typing into one change', async () => {
    answer = async () => {
      throw new TypeError('Failed to fetch');
    };
    const outbox = await freshOutbox();
    outbox.add({ type: 'comment.create', explorationId, comment });
    await outbox.flush();
    outbox.add({
      type: 'comment.update',
      explorationId,
      commentId: comment.id,
      changes: { editBody: 'Half a' },
    });
    outbox.add({
      type: 'comment.update',
      explorationId,
      commentId: comment.id,
      changes: { body: 'Whole', editBody: null },
    });
    await outbox.flush();
    expect(outbox.stalled.value).toBe(true);
    // Three changes, at most two requests: typing folds into the last unsent change.
    expect(outbox.changes.value.length).toBeLessThan(3);

    const reopened = await freshOutbox();
    answer = async () => ({});
    await reopened.flush();
    expect(reopened.changes.value).toEqual([]);
    // Either a create with the saved text or an update saving it; no editor left open.
    const saved = requests
      .at(-1)!
      .args.find(
        (arg): arg is { body: string; editBody?: string | null } =>
          typeof arg === 'object' && arg !== null && 'body' in arg,
      );
    expect(saved?.body).toBe('Whole');
    expect(saved?.editBody ?? null).toBeNull();
  });

  it('folds a change into an unsent comment', async () => {
    answer = async () => {
      throw new TypeError('Failed to fetch');
    };
    const outbox = await freshOutbox();
    outbox.add({
      type: 'reply-draft.save',
      explorationId,
      forkId: 'f',
      draft: { text: 'x', newFork: false, fileIds: [] },
    });
    await outbox.flush();
    outbox.add({ type: 'comment.create', explorationId, comment });
    outbox.add({
      type: 'comment.update',
      explorationId,
      commentId: comment.id,
      changes: { body: 'Whole', editBody: null },
    });
    const { editBody, ...saved } = comment;
    expect(outbox.changes.value.at(-1)).toEqual({
      type: 'comment.create',
      explorationId,
      comment: { ...saved, body: 'Whole' },
    });
    expect(editBody).toBe('Half');
  });

  it('withdraws a comment or a submit the daemon never got', async () => {
    answer = async () => {
      throw new ApiError('error', 'Bad gateway', 502);
    };
    const outbox = await freshOutbox();
    outbox.add({
      type: 'reply-draft.save',
      explorationId,
      forkId: 'f',
      draft: { text: 'x', newFork: false, fileIds: [] },
    });
    await outbox.flush();
    outbox.add({ type: 'comment.create', explorationId, comment });
    outbox.add({ type: 'comment.delete', explorationId, commentId: comment.id });
    outbox.add({
      type: 'submit',
      explorationId,
      submission: { id: 's000000001', forkId: 'f', globalMessage: 'Hi', newFork: false, files: [] },
    });
    outbox.add({ type: 'submission.cancel', explorationId, submissionId: 's000000001' });
    expect(outbox.changes.value.map(({ type }) => type)).toEqual(['reply-draft.save']);
  });

  it('drops a change the daemon refuses and reports it, but not a repeated delete', async () => {
    const outbox = await freshOutbox();
    const failed: string[] = [];
    outbox.onFailure((failedExplorationId) => failed.push(failedExplorationId));
    answer = async () => {
      throw new ApiError('not_found', 'Comment c000000001 does not exist.', 404);
    };
    outbox.add({ type: 'comment.delete', explorationId, commentId: comment.id });
    await outbox.flush();
    expect(outbox.failures).toEqual([]);

    answer = async () => {
      throw new ApiError('archived', 'Fork f is archived.', 409);
    };
    outbox.add({
      type: 'comment.update',
      explorationId,
      commentId: comment.id,
      changes: { body: 'x' },
    });
    await outbox.flush();
    expect(outbox.changes.value).toEqual([]);
    expect(outbox.failures.map(({ message }) => message)).toEqual([
      'Could not save: Fork f is archived.',
    ]);
    expect(failed).toEqual([explorationId]);
  });
});
