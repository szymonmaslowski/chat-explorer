import type { SpeechBlock } from '@shared/types';
import { reactive } from 'vue';
import { api } from '../api';
import { encodeWav } from '../lib/wav';

interface Playback {
  messageId: string;
  blocks: SpeechBlock[];
  index: number;
}

export const speechSkipSeconds = 5;
const chainStorageKey = 'chat-explorer.speech-chain';
const rateStorageKey = 'chat-explorer.speech-rate';
export const speechRates = [0.8, 0.9, 1, 1.1, 1.25];

function readChain() {
  try {
    return localStorage.getItem(chainStorageKey) !== 'off';
  } catch {
    return true;
  }
}

function readRate() {
  try {
    const stored = Number(localStorage.getItem(rateStorageKey));
    return speechRates.includes(stored) ? stored : 1;
  } catch {
    return 1;
  }
}

export const speech = reactive({
  available: false,
  playback: null as Playback | null,
  playing: false,
  loading: false,
  currentTime: 0,
  duration: 0,
  chain: readChain(),
  rate: readRate(),
  error: '',
});

let availability: Promise<boolean> | null = null;

export function checkSpeechAvailable() {
  availability ??= api.settings().then(
    (settings) => (speech.available = settings.speech),
    () => false,
  );
  return availability;
}

const audio = new Audio();
// A new source resets playbackRate to this, so every block keeps the chosen speed.
audio.defaultPlaybackRate = speech.rate;
let unlocked = false;
let loadToken = 0;
interface CachedAudio {
  url: Promise<string>;
  bytes: number;
}

// About an hour of speech. Kept after Stop, so playing a block again needs no new request.
const maxCachedBytes = 20 * 1024 * 1024;
// Least recently played first: a block moves to the end each time it plays.
const cachedAudio = new Map<string, CachedAudio>();

// Safari only lets a page start audio from a tap. Playing silence during the tap unlocks this
// element, so the next blocks can start after the audio has been fetched, even on a locked phone.
function unlockAudio() {
  if (unlocked) return;
  unlocked = true;
  audio.src = URL.createObjectURL(
    new Blob([encodeWav(new Float32Array(1_600), 16_000)], { type: 'audio/wav' }),
  );
  audio.play().catch(() => {});
}

function evictAudio() {
  let total = 0;
  for (const cached of cachedAudio.values()) total += cached.bytes;
  for (const [key, cached] of cachedAudio) {
    if (total <= maxCachedBytes) return;
    cachedAudio.delete(key);
    total -= cached.bytes;
    void cached.url.then(URL.revokeObjectURL);
  }
}

function audioFor(playback: Playback, index: number) {
  const key = `${playback.messageId}:${index}`;
  const cached = cachedAudio.get(key);
  if (cached) {
    cachedAudio.delete(key);
    cachedAudio.set(key, cached);
    return cached.url;
  }
  const entry: CachedAudio = {
    bytes: 0,
    url: api.speech(playback.messageId, playback.blocks[index]!).then((audio) => {
      entry.bytes = audio.size;
      evictAudio();
      return URL.createObjectURL(audio);
    }),
  };
  cachedAudio.set(key, entry);
  entry.url.catch(() => cachedAudio.delete(key));
  return entry.url;
}

// A negative position counts back from the end of the block.
async function load(index: number, position = 0) {
  const playback = speech.playback;
  if (!playback) return;
  const token = ++loadToken;
  playback.index = index;
  speech.loading = true;
  speech.error = '';
  speech.currentTime = 0;
  try {
    const url = await audioFor(playback, index);
    if (token !== loadToken) return;
    audio.src = url;
    await new Promise((resolve) =>
      audio.addEventListener('loadedmetadata', resolve, { once: true }),
    );
    if (token !== loadToken) return;
    audio.currentTime = position < 0 ? Math.max(0, audio.duration + position) : position;
    await audio.play();
    if (speech.chain && index + 1 < playback.blocks.length) void audioFor(playback, index + 1);
  } catch (error) {
    if (token !== loadToken) return;
    speech.playing = false;
    speech.error = error instanceof Error ? error.message : 'Could not read this aloud.';
  } finally {
    if (token === loadToken) speech.loading = false;
  }
}

export function playFrom(messageId: string, blocks: SpeechBlock[], index: number) {
  unlockAudio();
  if (speech.playback?.messageId !== messageId) setMediaMetadata();
  speech.playback = { messageId, blocks, index };
  void load(index);
}

export function playBlock(messageId: string, blocks: SpeechBlock[], index: number) {
  const playback = speech.playback;
  if (playback?.messageId === messageId && playback.index === index) togglePause();
  else playFrom(messageId, blocks, index);
}

export function togglePause() {
  if (!speech.playback || speech.loading) return;
  if (audio.paused) void audio.play();
  else audio.pause();
}

export function stopSpeech() {
  loadToken++;
  audio.pause();
  audio.removeAttribute('src');
  audio.load();
  Object.assign(speech, {
    playback: null,
    playing: false,
    loading: false,
    currentTime: 0,
    duration: 0,
    error: '',
  });
}

export function goToBlock(index: number) {
  const playback = speech.playback;
  if (!playback || index < 0 || index >= playback.blocks.length) return;
  void load(index);
}

// Skipping past either end of a block carries on into the neighbouring block.
export function skip(seconds: number) {
  const playback = speech.playback;
  if (!playback || speech.loading) return;
  const target = audio.currentTime + seconds;
  if (target < 0 && playback.index > 0) {
    void load(playback.index - 1, target);
  } else if (target >= audio.duration && playback.index + 1 < playback.blocks.length) {
    void load(playback.index + 1, target - audio.duration);
  } else {
    audio.currentTime = Math.min(Math.max(0, target), audio.duration);
  }
}

export function seekTo(seconds: number) {
  if (speech.playback && !speech.loading) audio.currentTime = seconds;
}

// The browser keeps the pitch at any speed.
export function setRate(rate: number) {
  speech.rate = rate;
  audio.defaultPlaybackRate = rate;
  audio.playbackRate = rate;
  updatePositionState();
  try {
    localStorage.setItem(rateStorageKey, String(rate));
  } catch {}
}

export function setChain(chain: boolean) {
  speech.chain = chain;
  try {
    localStorage.setItem(chainStorageKey, chain ? 'on' : 'off');
  } catch {}
}

audio.addEventListener('play', () => (speech.playing = true));
audio.addEventListener('pause', () => (speech.playing = false));
audio.addEventListener('timeupdate', () => {
  speech.currentTime = audio.currentTime;
  updatePositionState();
});
audio.addEventListener('durationchange', () => {
  speech.duration = Number.isFinite(audio.duration) ? audio.duration : 0;
});
audio.addEventListener('ended', () => {
  const playback = speech.playback;
  if (!playback || speech.loading || !speech.chain) return;
  if (playback.index + 1 < playback.blocks.length) void load(playback.index + 1);
  else stopSpeech();
});

function setMediaMetadata() {
  if (!('mediaSession' in navigator)) return;
  navigator.mediaSession.metadata = new MediaMetadata({ title: document.title, artist: 'Claude' });
}

function updatePositionState() {
  if (!('mediaSession' in navigator) || !Number.isFinite(audio.duration)) return;
  try {
    navigator.mediaSession.setPositionState({
      duration: audio.duration,
      position: Math.min(audio.currentTime, audio.duration),
      playbackRate: audio.playbackRate,
    });
  } catch {}
}

const mediaActions: [MediaSessionAction, MediaSessionActionHandler][] = [
  ['play', () => void audio.play()],
  ['pause', () => audio.pause()],
  ['stop', stopSpeech],
  ['seekbackward', () => skip(-speechSkipSeconds)],
  ['seekforward', () => skip(speechSkipSeconds)],
  ['previoustrack', () => goToBlock((speech.playback?.index ?? 0) - 1)],
  ['nexttrack', () => goToBlock((speech.playback?.index ?? 0) + 1)],
];

if ('mediaSession' in navigator) {
  for (const [action, handler] of mediaActions) {
    try {
      navigator.mediaSession.setActionHandler(action, handler);
    } catch {}
  }
}
