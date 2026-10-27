import { onBeforeUnmount, ref } from 'vue';
import { api, ApiError } from '../api';
import { toWav } from '../lib/wav';

type DictationState = 'idle' | 'recording' | 'transcribing';

interface Recording {
  stream: MediaStream;
  recorder: MediaRecorder;
  chunks: Blob[];
  meterContext: AudioContext;
  wakeLock: Promise<WakeLockSentinel | null>;
  meterFrame: number;
  peakLevel: number;
}

const maxRecordingSeconds = 600;
// Loudness (RMS) that speech passes and a quiet room stays under. Whisper invents words for
// silence, so a recording that never got this loud is not sent.
const speechLevel = 0.02;

let availability: Promise<boolean> | null = null;
let cancelActive: (() => void) | null = null;

function dictationAvailable() {
  const browserCanRecord =
    window.isSecureContext &&
    navigator.mediaDevices !== undefined &&
    typeof MediaRecorder !== 'undefined';
  if (!browserCanRecord) return Promise.resolve(false);
  availability ??= api.settings().then(
    (settings) => settings.dictation,
    () => false,
  );
  return availability;
}

function microphoneError(error: unknown) {
  if (error instanceof DOMException && error.name === 'NotAllowedError') {
    return 'Microphone access is blocked. Allow it for this site in the browser settings.';
  }
  if (error instanceof DOMException && error.name === 'NotFoundError') {
    return 'No microphone found.';
  }
  return `Could not start the microphone: ${error instanceof Error ? error.message : error}`;
}

function finishRecording(recording: Recording) {
  cancelAnimationFrame(recording.meterFrame);
  return new Promise<Blob>((resolve) => {
    recording.recorder.onstop = () =>
      resolve(new Blob(recording.chunks, { type: recording.recorder.mimeType }));
    recording.recorder.stop();
  }).finally(() => {
    for (const track of recording.stream.getTracks()) track.stop();
    void recording.meterContext.close();
    void recording.wakeLock.then((lock) => lock?.release());
  });
}

export function useDictation(options: { hint: () => string; onText: (text: string) => void }) {
  const available = ref(false);
  const state = ref<DictationState>('idle');
  const error = ref('');
  const seconds = ref(0);
  const level = ref(0);
  let recording: Recording | null = null;
  let transcription: AbortController | null = null;

  void dictationAvailable().then((value) => (available.value = value));

  async function start() {
    cancelActive?.();
    error.value = '';
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      recording = record(stream);
      cancelActive = cancel;
      state.value = 'recording';
    } catch (failure) {
      error.value = microphoneError(failure);
    }
  }

  function record(stream: MediaStream) {
    const meterContext = new AudioContext();
    const analyser = meterContext.createAnalyser();
    meterContext.createMediaStreamSource(stream).connect(analyser);
    const samples = new Float32Array(analyser.fftSize);
    const recorder = new MediaRecorder(stream);
    const current: Recording = {
      stream,
      recorder,
      chunks: [],
      meterContext,
      // iOS stops recording when the screen locks.
      wakeLock: navigator.wakeLock?.request('screen').catch(() => null) ?? Promise.resolve(null),
      meterFrame: 0,
      peakLevel: 0,
    };
    recorder.ondataavailable = (event) => current.chunks.push(event.data);
    recorder.start();
    const startedAt = performance.now();
    const measure = () => {
      analyser.getFloatTimeDomainData(samples);
      const squares = samples.reduce((sum, sample) => sum + sample * sample, 0);
      level.value = Math.sqrt(squares / samples.length);
      current.peakLevel = Math.max(current.peakLevel, level.value);
      seconds.value = (performance.now() - startedAt) / 1000;
      if (seconds.value >= maxRecordingSeconds) return void stop();
      current.meterFrame = requestAnimationFrame(measure);
    };
    measure();
    return current;
  }

  async function stop() {
    if (!recording) return;
    const finished = recording;
    recording = null;
    level.value = 0;
    const audio = await finishRecording(finished);
    if (finished.peakLevel < speechLevel) {
      state.value = 'idle';
      error.value = 'No speech heard. Try again closer to the microphone.';
      return;
    }
    state.value = 'transcribing';
    const controller = new AbortController();
    transcription = controller;
    try {
      const { text } = await api.transcribe(await toWav(audio), options.hint(), controller.signal);
      if (text) options.onText(text);
    } catch (failure) {
      if (!controller.signal.aborted) {
        error.value = failure instanceof ApiError ? failure.message : 'Transcription failed.';
      }
    } finally {
      if (transcription === controller) {
        transcription = null;
        state.value = 'idle';
      }
      if (cancelActive === cancel) cancelActive = null;
    }
  }

  function cancel() {
    if (recording) void finishRecording(recording);
    recording = null;
    transcription?.abort();
    transcription = null;
    level.value = 0;
    state.value = 'idle';
    if (cancelActive === cancel) cancelActive = null;
  }

  onBeforeUnmount(cancel);

  return { available, state, error, seconds, level, start, stop, cancel };
}
