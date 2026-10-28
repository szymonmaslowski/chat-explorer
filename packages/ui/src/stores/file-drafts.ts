import type { MessageFile } from '@shared/types';
import { computed, reactive } from 'vue';
import { api, ApiError } from '../api';

export interface DraftFile {
  key: number;
  name: string;
  previewUrl: string | null;
  status: 'uploading' | 'ready' | 'failed';
  error: string;
  file: MessageFile | null;
}

// Files picked for a text box, by box: they upload at once and wait there until it is sent.
const draftsByOwner = reactive(new Map<string, DraftFile[]>());
let nextKey = 0;

const previewableImage = /^image\/(png|jpeg|gif|webp)$/;

export const replyFilesOwner = (forkId: string) => `fork:${forkId}`;
export const newChatFilesOwner = 'new-chat';

function draftsOf(owner: string) {
  if (!draftsByOwner.has(owner)) draftsByOwner.set(owner, []);
  return draftsByOwner.get(owner)!;
}

function forget(draft: DraftFile) {
  if (draft.previewUrl?.startsWith('blob:')) URL.revokeObjectURL(draft.previewUrl);
}

async function upload(owner: string, draft: DraftFile, file: File) {
  try {
    draft.file = await api.uploadFile(file);
    draft.status = 'ready';
    if (!draftsOf(owner).includes(draft)) void api.deleteFile(draft.file.id).catch(() => {});
  } catch (error) {
    draft.status = 'failed';
    draft.error = error instanceof ApiError ? error.message : 'Upload failed.';
  }
}

export function restoreFileDrafts(owner: string, files: MessageFile[]) {
  const drafts = draftsOf(owner);
  for (const file of files) {
    drafts.push({
      key: nextKey++,
      name: file.name,
      previewUrl: file.kind === 'image' ? `/api/files/${file.id}` : null,
      status: 'ready',
      error: '',
      file,
    });
  }
}

export function useFileDrafts(owner: () => string) {
  const drafts = computed(() => draftsByOwner.get(owner()) ?? []);
  const readyIds = computed(() =>
    drafts.value.flatMap((draft) => (draft.file ? [draft.file.id] : [])),
  );
  const uploading = computed(() => drafts.value.some((draft) => draft.status === 'uploading'));

  function add(files: File[]) {
    const key = owner();
    const list = draftsOf(key);
    for (const file of files) {
      list.push({
        key: nextKey++,
        name: file.name || 'pasted file',
        previewUrl: previewableImage.test(file.type) ? URL.createObjectURL(file) : null,
        status: 'uploading',
        error: '',
        file: null,
      });
      void upload(key, list.at(-1)!, file);
    }
  }

  function remove(draft: DraftFile) {
    const list = draftsOf(owner());
    list.splice(list.indexOf(draft), 1);
    forget(draft);
    if (draft.file) void api.deleteFile(draft.file.id).catch(() => {});
  }

  // After a send: the files now belong to the message, so they stay on the server.
  function clear() {
    for (const draft of draftsOf(owner())) forget(draft);
    draftsByOwner.set(owner(), []);
  }

  return { drafts, readyIds, uploading, add, remove, clear };
}
