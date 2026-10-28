import { existsSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { classifyFile, storedFileName } from '../src/files/kinds.js';
import type { MessageFile } from '../src/shared/types.js';
import { createTestApp, seedConversation } from './helpers.js';

const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const text = (content: string) => new TextEncoder().encode(content);

describe('file kinds', () => {
  it('recognises images by type or extension', () => {
    expect(classifyFile('image.png', 'image/png', png)).toMatchObject({ kind: 'image' });
    expect(classifyFile('photo.JPG', '', png)).toMatchObject({
      kind: 'image',
      mediaType: 'image/jpeg',
    });
  });

  it('accepts a PDF only when it starts like one', () => {
    expect(classifyFile('paper.pdf', 'application/pdf', text('%PDF-1.7'))).toMatchObject({
      kind: 'pdf',
    });
    expect(classifyFile('paper.pdf', 'application/pdf', new Uint8Array([0, 1, 2]))).toBeNull();
  });

  it('treats any UTF-8 file as text, whatever the browser called it', () => {
    expect(classifyFile('store.ts', 'video/mp2t', text('export const a = 1;'))).toMatchObject({
      kind: 'text',
    });
    expect(classifyFile('notes', '', text('zażółć gęślą jaźń'))).toMatchObject({ kind: 'text' });
    expect(
      classifyFile('archive.zip', 'application/zip', new Uint8Array([80, 75, 3, 4, 0])),
    ).toBeNull();
  });

  it('keeps a safe name with a matching extension', () => {
    const image = classifyFile('x.png', 'image/png', png)!;
    expect(storedFileName('../../etc/Screen Shot?.png', image)).toBe('Screen Shot_.png');
    expect(storedFileName('pasted', image)).toBe('pasted.png');
    const plain = classifyFile('notes', '', text('hello'))!;
    expect(storedFileName('notes', plain)).toBe('notes.txt');
    expect(storedFileName('store.ts', classifyFile('store.ts', '', text('a'))!)).toBe('store.ts');
  });
});

describe('files API', () => {
  async function upload(request: ReturnType<typeof createTestApp>['request'], file: File) {
    const form = new FormData();
    form.append('file', file);
    return request('/api/files', { method: 'POST', body: form });
  }

  it('stores an upload, serves it and sends its path to Claude with the reply', async () => {
    const { request, store } = createTestApp();
    const { explorationId, mainForkId } = seedConversation(store);
    const uploaded = await upload(request, new File([png], 'diagram.png', { type: 'image/png' }));
    expect(uploaded.status).toBe(201);
    const file: MessageFile = await uploaded.json();
    expect(file).toMatchObject({ name: 'diagram.png', kind: 'image', size: png.length });

    const served = await request(`/api/files/${file.id}`);
    expect(served.headers.get('content-type')).toBe('image/png');
    expect(new Uint8Array(await served.arrayBuffer())).toEqual(png);

    await request(`/api/explorations/${explorationId}/submit`, {
      method: 'POST',
      json: { forkId: mainForkId, globalMessage: 'What is this?', fileIds: [file.id] },
    });
    expect(store.snapshot(explorationId).files).toMatchObject([{ id: file.id, messageId: null }]);
    store.deliverQueued(explorationId);

    const [main] = store.pendingForks(explorationId);
    const path = store.fileRow(file.id).path;
    expect(path).toMatch(/\/diagram\.png$/);
    expect(main!.userMessages[0]!.text).toBe(
      `What is this?\n\nAttached files (open them with the Read tool):\n- ${path}`,
    );
    expect(store.snapshot(explorationId).files[0]!.messageId).toBe(main!.userMessages[0]!.id);
  });

  it('serves text as plain text so HTML is never run', async () => {
    const { request } = createTestApp();
    const file: MessageFile = await (
      await upload(
        request,
        new File(['<script>alert(1)</script>'], 'page.html', { type: 'text/html' }),
      )
    ).json();
    const served = await request(`/api/files/${file.id}`);
    expect(served.headers.get('content-type')).toBe('text/plain; charset=utf-8');
    expect(served.headers.get('x-content-type-options')).toBe('nosniff');
  });

  it('refuses files that are too large or of another kind', async () => {
    const { request } = createTestApp();
    const large = await upload(
      request,
      new File([new Uint8Array(10 * 1024 * 1024 + 1)], 'big.txt'),
    );
    expect(large.status).toBe(413);
    const zip = await upload(
      request,
      new File([new Uint8Array([80, 75, 3, 4, 0])], 'archive.zip', { type: 'application/zip' }),
    );
    expect(zip.status).toBe(415);
  });

  it('gives files back as drafts when a submission is cancelled, and deletes drafts', async () => {
    const { request, store } = createTestApp();
    const { explorationId, mainForkId } = seedConversation(store);
    const file: MessageFile = await (await upload(request, new File(['notes'], 'notes.md'))).json();
    const submission = store.submit(explorationId, mainForkId, '', { fileIds: [file.id] });
    expect(store.cancelSubmission(submission.id).files).toMatchObject([
      { id: file.id, submissionId: null },
    ]);
    expect(store.snapshot(explorationId).files).toEqual([]);

    const path = store.fileRow(file.id).path;
    expect((await request(`/api/files/${file.id}`, { method: 'DELETE' })).status).toBe(200);
    expect(existsSync(path)).toBe(false);
  });

  it('refuses to submit a file twice', async () => {
    const { request, store } = createTestApp();
    const { explorationId, mainForkId } = seedConversation(store);
    const file: MessageFile = await (await upload(request, new File(['a'], 'a.txt'))).json();
    store.submit(explorationId, mainForkId, '', { fileIds: [file.id] });
    expect(() => store.submit(explorationId, mainForkId, 'again', { fileIds: [file.id] })).toThrow(
      expect.objectContaining({ code: 'not_draft' }),
    );
  });

  it('deletes the files of a purged chat and drafts left for a day', async () => {
    const { request, store, clock, fileStorage } = createTestApp();
    const { explorationId, mainForkId } = seedConversation(store);
    const sent: MessageFile = await (await upload(request, new File(['a'], 'a.txt'))).json();
    const left: MessageFile = await (await upload(request, new File(['b'], 'b.txt'))).json();
    const sentPath = store.fileRow(sent.id).path;
    const leftPath = store.fileRow(left.id).path;
    store.submit(explorationId, mainForkId, '', { fileIds: [sent.id] });

    await request(`/api/explorations/${explorationId}?purge=true`, { method: 'DELETE' });
    expect(existsSync(sentPath)).toBe(false);
    expect(existsSync(leftPath)).toBe(true);

    await fileStorage.removeStaleDrafts();
    expect(existsSync(leftPath)).toBe(true);
    clock.now += 25 * 60 * 60 * 1000;
    await fileStorage.removeStaleDrafts();
    expect(existsSync(leftPath)).toBe(false);
  });

  it('starts a chat with only a file', async () => {
    const { request, store } = createTestApp();
    const file: MessageFile = await (await upload(request, new File(['a'], 'a.txt'))).json();
    const created = await request('/api/explorations', {
      method: 'POST',
      json: { fileIds: [file.id] },
    });
    expect(created.status).toBe(201);
    const { explorationId } = await created.json();
    expect(store.snapshot(explorationId).files).toHaveLength(1);
  });
});
