import { join } from 'node:path';

export const whisperModels = ['large-v3-turbo-q5_0'] as const;

export type WhisperModel = (typeof whisperModels)[number];

export const defaultWhisperModel: WhisperModel = 'large-v3-turbo-q5_0';

export interface WhisperModelFile {
  fileName: string;
  url: string;
  bytes: number;
  sha256: string;
}

export const whisperModelFiles: Record<WhisperModel, WhisperModelFile> = {
  'large-v3-turbo-q5_0': {
    fileName: 'ggml-large-v3-turbo-q5_0.bin',
    url: 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo-q5_0.bin',
    bytes: 574_041_195,
    sha256: '394221709cd5ad1f40c46e6031ca61bce88931e6e088c188294c6d5a55ffa7e2',
  },
};

export function whisperModelPath(modelsPath: string, model: WhisperModel) {
  return join(modelsPath, whisperModelFiles[model].fileName);
}
