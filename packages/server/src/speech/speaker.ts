import { messageSpeechBlocks } from '../shared/message-speech-blocks.js';
import type { SpeechBlock } from '../shared/types.js';
import { StoreError } from '../store/errors.js';
import { speechText } from './announcements.js';
import type { SpeechEngine } from './engines.js';
import { speechCacheKey, type SpeechCache } from './speech-cache.js';
import type { SpeechInspection } from './voices.js';

export interface SpeakerOptions {
  // In order of preference: a message is read by the first engine that is installed and speaks
  // its language.
  engines: SpeechEngine[];
  inspect: (text: string) => Promise<SpeechInspection>;
  cache: SpeechCache;
}

interface SpeechRequest {
  messageId: string;
  content: string;
  block: SpeechBlock;
  signal: AbortSignal;
}

interface Voice {
  engine: SpeechEngine;
  voice: string;
  language: string | null;
}

interface QueuedRender {
  key: string;
  messageId: string;
  // Asked for by a reader waiting to hear it, not rendered ahead.
  awaited: boolean;
  start: () => Promise<unknown>;
}

// Language detection needs a few sentences; more only makes osascript's argument longer.
const maxInspectedLength = 4_000;
const unknownLanguage: SpeechInspection = { language: null, voices: [], preferredVoice: null };

// Code tells nothing about the language of the prose around it.
const proseOf = (markdown: string) =>
  markdown.replace(/```[\s\S]*?```/g, ' ').slice(0, maxInspectedLength);

export class Speaker {
  private readonly renders = new Map<string, Promise<Uint8Array<ArrayBuffer>>>();
  private readonly queue: QueuedRender[] = [];
  private queueRunning = false;
  private listenedMessageId: string | null = null;

  constructor(private readonly options: SpeakerOptions) {}

  available() {
    return this.options.engines.some((engine) => engine.available());
  }

  async speak({ messageId, content, block, signal }: SpeechRequest) {
    const voice = await this.voiceFor(content);
    const text = speechText(block, voice.language);
    const key = speechCacheKey(voice.engine.name, voice.voice, text);
    const cached = await this.options.cache.read(key);
    const audio =
      cached ??
      (voice.engine.rendersAhead
        ? await untilAborted(this.enqueue(voice, text, key, messageId, true), signal)
        : await this.render(voice, text, key, signal));
    return { audio, contentType: voice.engine.contentType };
  }

  // Renders every block of a new answer in the background, so an engine too slow to wait for
  // plays at once later.
  async prepare(messageId: string, content: string) {
    const voice = await this.voiceFor(content).catch(() => null);
    if (!voice?.engine.rendersAhead) return;
    for (const block of messageSpeechBlocks(content)) {
      const text = speechText(block, voice.language);
      const key = speechCacheKey(voice.engine.name, voice.voice, text);
      if (this.renders.has(key) || (await this.options.cache.has(key))) continue;
      this.enqueue(voice, text, key, messageId, false).catch(() => {});
    }
  }

  // Chosen again for every block, so a newly installed voice is used at once. The same message
  // always detects as the same language, so its blocks still share one voice.
  private async voiceFor(content: string): Promise<Voice> {
    const inspection = await this.options.inspect(proseOf(content)).catch(() => unknownLanguage);
    for (const engine of this.options.engines) {
      if (!engine.available()) continue;
      const voice = engine.voiceFor(inspection);
      if (voice !== null) return { engine, voice, language: inspection.language };
    }
    throw new StoreError(
      'speech_unavailable',
      'Reading aloud needs macOS speech (`say`) or `chat-explorer speech install`.',
    );
  }

  // One render at a time: blocks someone waits for first, then the rest of the answer they
  // listen to, then the other answers in the order they arrived.
  private enqueue(voice: Voice, text: string, key: string, messageId: string, awaited: boolean) {
    if (awaited) this.listenedMessageId = messageId;
    const queued = this.queue.find((render) => render.key === key);
    if (queued) queued.awaited ||= awaited;
    const rendering =
      this.renders.get(key) ??
      new Promise<Uint8Array<ArrayBuffer>>((resolve, reject) => {
        this.queue.push({
          key,
          messageId,
          awaited,
          start: () => this.render(voice, text, key).then(resolve, reject),
        });
      });
    if (!this.renders.has(key)) {
      this.renders.set(key, rendering);
      rendering.then(
        () => this.renders.delete(key),
        () => this.renders.delete(key),
      );
    }
    const priority = (render: QueuedRender) =>
      render.awaited ? 0 : render.messageId === this.listenedMessageId ? 1 : 2;
    this.queue.sort((first, second) => priority(first) - priority(second));
    void this.runQueue();
    return rendering;
  }

  private async runQueue() {
    if (this.queueRunning) return;
    this.queueRunning = true;
    try {
      for (let render = this.queue.shift(); render; render = this.queue.shift()) {
        await render.start();
      }
    } finally {
      this.queueRunning = false;
    }
  }

  private async render({ engine, voice }: Voice, text: string, key: string, signal?: AbortSignal) {
    const timeout = AbortSignal.timeout(engine.timeoutMs);
    try {
      const audio = await engine.synthesize(
        text,
        voice,
        signal ? AbortSignal.any([signal, timeout]) : timeout,
      );
      await this.options.cache.write(key, audio).catch(() => {});
      return audio;
    } catch (error) {
      if (signal?.aborted) throw new StoreError('cancelled', 'Reading aloud was cancelled.');
      throw new StoreError(
        'speech_failed',
        timeout.aborted
          ? 'Speech took too long and was stopped.'
          : `Speech failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}

// A reader who stops listening stops waiting, but the render goes on into the cache.
function untilAborted<Result>(promise: Promise<Result>, signal: AbortSignal) {
  return new Promise<Result>((resolve, reject) => {
    const abort = () => reject(new StoreError('cancelled', 'Reading aloud was cancelled.'));
    if (signal.aborted) return abort();
    signal.addEventListener('abort', abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}
