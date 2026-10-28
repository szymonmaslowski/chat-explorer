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

function readChain() {
  try {
    return localStorage.getItem(chainStorageKey) !== 'off';
  } catch {
    return true;
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
let unlocked = false;
let loadToken = 0;
const audioUrls = new Map<string, Promise<string>>();

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

function forgetAudio() {
  for (const url of audioUrls.values()) void url.then(URL.revokeObjectURL, () => {});
  audioUrls.clear();
}

function audioFor(playback: Playback, index: number) {
  const key = `${playback.messageId}:${index}`;
  let url = audioUrls.get(key);
  if (!url) {
    url = api.speech(playback.messageId, playback.blocks[index]!).then(URL.createObjectURL);
    audioUrls.set(key, url);
    url.catch(() => audioUrls.delete(key));
  }
  return url;
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
  if (speech.playback?.messageId !== messageId) {
    forgetAudio();
    setMediaMetadata();
  }
  speech.playback = { messageId, blocks, index };
  void load(index);
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
  forgetAudio();
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
