import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../src/api/app.js';
import { Database } from '../src/db/database.js';
import type { DictationAvailability } from '../src/dictation/availability.js';
import { Transcriber } from '../src/dictation/transcriber.js';
import type { WhisperRun } from '../src/dictation/whisper.js';
import { BackgroundSessions } from '../src/sessions/background-sessions.js';
import { FileStorage } from '../src/files/file-storage.js';
import type { SpeechEngine, SpeechEngineName } from '../src/speech/engines.js';
import { Speaker } from '../src/speech/speaker.js';
import { SpeechCache } from '../src/speech/speech-cache.js';
import { chooseVoice, type SpeechInspection } from '../src/speech/voices.js';
import type { LaunchSpec, SessionProcess } from '../src/sessions/launch-claude.js';
import type { ExplorationEvent } from '../src/shared/types.js';
import { EventBus } from '../src/store/event-bus.js';
import { FeedbackHub } from '../src/store/feedback-hub.js';
import { ChatStore } from '../src/store/store.js';

export const testPort = 4999;

export function createTestStore() {
  const clock = { now: 1_000_000 };
  const now = () => clock.now;
  const database = new Database(':memory:');
  const bus = new EventBus();
  const events: ExplorationEvent[] = [];
  bus.subscribe((_explorationId, event) => events.push(event));
  const store = new ChatStore(database, bus, now);
  const { sessions, launches } = createTestSessions({
    store,
    bus,
    now,
    onStatusChange: (explorationId) => hub.refreshStatus(explorationId),
  });
  const hub = new FeedbackHub(store, bus, now, sessions);
  return { clock, database, bus, store, hub, sessions, launches, events };
}

export function createTestSessions(input: {
  store: ChatStore;
  bus: EventBus;
  now?: () => number;
  onStatusChange: (explorationId: string) => void;
}) {
  const launches: FakeLaunch[] = [];
  const sessions = new BackgroundSessions({
    ...input,
    settings: { idleMinutes: 60, maxSessions: 2 },
    sessionsPath: mkdtempSync(join(tmpdir(), 'chat-explorer-sessions-')),
    launch: (spec) => {
      const launch = fakeLaunch(spec);
      launches.push(launch);
      return launch.process;
    },
    canResume: () => true,
  });
  return { sessions, launches };
}

export interface FakeLaunch {
  spec: LaunchSpec;
  process: SessionProcess;
  stopped: boolean;
  exit: (code: number | null, error?: string) => void;
}

function fakeLaunch(spec: LaunchSpec): FakeLaunch {
  const listeners: ((result: { code: number | null; error?: string }) => void)[] = [];
  const launch: FakeLaunch = {
    spec,
    stopped: false,
    process: {
      stop: () => {
        launch.stopped = true;
      },
      onExit: (listener) => listeners.push(listener),
    },
    exit: (code, error) => {
      for (const listener of listeners) listener(error ? { code, error } : { code });
    },
  };
  return launch;
}

export interface FakeWhisperCall {
  whisperPath: string;
  args: string[];
  signal: AbortSignal;
  audio: Buffer;
  finish: (run: Partial<WhisperRun>) => void;
}

export function createTestTranscriber(options: { timeoutMs?: number } = {}) {
  const calls: FakeWhisperCall[] = [];
  const availability: { current: DictationAvailability } = {
    current: { available: true, whisperPath: '/bin/whisper-cli', modelPath: '/models/test.bin' },
  };
  const transcriber = new Transcriber({
    language: 'auto',
    checkAvailability: () => availability.current,
    timeoutMs: options.timeoutMs,
    run: (whisperPath, args, signal) =>
      new Promise((resolve, reject) => {
        const audioPath = args[args.indexOf('-f') + 1]!;
        signal.addEventListener('abort', () => reject(signal.reason));
        calls.push({
          whisperPath,
          args,
          signal,
          audio: readFileSync(audioPath),
          finish: (run) => resolve({ code: 0, stdout: '', stderr: '', ...run }),
        });
      }),
  });
  return { transcriber, calls, availability };
}

export interface FakeSpeechCall {
  text: string;
  voice: string;
}

// Speaks like `say` (a Mac voice chosen for the language) or like Chatterbox (any language in
// `languages`, rendered ahead). A held engine finishes each call only when `finishNext` runs.
export function createFakeEngine(
  name: SpeechEngineName,
  options: { languages?: string[]; held?: boolean } = {},
) {
  const spoken: FakeSpeechCall[] = [];
  const unfinished: (() => void)[] = [];
  const engine: SpeechEngine = {
    name,
    contentType: name === 'say' ? 'audio/mp4' : 'audio/mpeg',
    rendersAhead: name === 'chatterbox',
    timeoutMs: 1_000,
    available: () => true,
    voiceFor: (inspection) =>
      name === 'say'
        ? (chooseVoice(inspection).identifier ?? '')
        : inspection.language && options.languages?.includes(inspection.language)
          ? inspection.language
          : null,
    synthesize: (text, voice) =>
      new Promise((resolve) => {
        spoken.push({ text, voice });
        const finish = () => resolve(new TextEncoder().encode(`${name}:${text}`));
        if (options.held) unfinished.push(finish);
        else finish();
      }),
  };
  const finishNext = () => unfinished.shift()?.();
  return { engine, spoken, finishNext };
}

// Engines in order of preference; `spoken` records the last one, `say` unless given others.
export function createTestSpeaker(
  inspection: SpeechInspection = {
    language: 'en',
    voices: [{ identifier: 'com.apple.voice.compact.en-GB.Daniel', language: 'en-GB', quality: 1 }],
    preferredVoice: null,
  },
  fakeEngines = [createFakeEngine('say')],
) {
  const inspected: string[] = [];
  const speaker = new Speaker({
    engines: fakeEngines.map(({ engine }) => engine),
    inspect: async (text) => {
      inspected.push(text);
      return inspection;
    },
    cache: new SpeechCache(mkdtempSync(join(tmpdir(), 'chat-explorer-speech-cache-')), 1_000_000),
  });
  return { speaker, inspected, spoken: fakeEngines.at(-1)!.spoken };
}

export function createTestApp(options: { publicUrl?: string } = {}) {
  const context = createTestStore();
  const { transcriber, calls: whisperCalls } = createTestTranscriber();
  const { speaker, inspected, spoken } = createTestSpeaker();
  const fileStorage = new FileStorage(
    context.store,
    mkdtempSync(join(tmpdir(), 'chat-explorer-files-')),
    () => context.clock.now,
  );
  const app = createApp({
    store: context.store,
    hub: context.hub,
    bus: context.bus,
    sessions: context.sessions,
    transcriber,
    speaker,
    fileStorage,
    defaultModel: 'sonnet',
    port: testPort,
    publicUrl: options.publicUrl ?? null,
    version: '0.0.0-test',
    uiDirectory: null,
    onShutdown: () => {},
  });
  const request = (path: string, init: RequestInit & { json?: object } = {}) => {
    const { json, ...rest } = init;
    const headers = new Headers(rest.headers);
    if (!headers.has('host')) headers.set('host', `127.0.0.1:${testPort}`);
    if (json) headers.set('content-type', 'application/json');
    return app.request(`http://127.0.0.1:${testPort}${path}`, {
      ...rest,
      headers,
      body: json ? JSON.stringify(json) : rest.body,
    });
  };
  return { ...context, app, request, whisperCalls, inspected, spoken, fileStorage };
}

export function seedConversation(store: ChatStore) {
  const { exploration, mainFork } = store.createExploration({
    title: 'Test',
    messages: [
      { role: 'user', content: 'Question one' },
      { role: 'assistant', content: 'Answer one with some text to quote' },
    ],
  });
  const [question, answer] = store.readFork(mainFork.id).messages;
  return {
    explorationId: exploration.id,
    mainForkId: mainFork.id,
    question: question!,
    answer: answer!,
  };
}

export function draft(
  store: ChatStore,
  explorationId: string,
  input: { messageId: string; viewForkId: string; body: string; type?: 'inline' | 'fork' },
) {
  return store.createComment(explorationId, {
    quote: 'some text',
    startOffset: 16,
    endOffset: 25,
    ...input,
  });
}
