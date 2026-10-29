<script setup lang="ts">
import {
  goToBlock,
  seekTo,
  setChain,
  setRate,
  skip,
  speech,
  speechRates,
  speechSkipSeconds,
  stopSpeech,
  togglePause,
} from '../stores/speech';
import MediaIcon from './MediaIcon.vue';

const clock = (seconds: number) => {
  const wholeSeconds = Math.floor(seconds);
  return `${Math.floor(wholeSeconds / 60)}:${String(wholeSeconds % 60).padStart(2, '0')}`;
};

const nextRate = () => speechRates[(speechRates.indexOf(speech.rate) + 1) % speechRates.length]!;

function onSeek(event: Event) {
  if (event.target instanceof HTMLInputElement) seekTo(Number(event.target.value));
}
</script>

<template>
  <section v-if="speech.playback" class="speech-player" aria-label="Reading aloud">
    <div class="progress">
      <input
        type="range"
        min="0"
        :max="speech.duration"
        step="0.1"
        :value="speech.currentTime"
        :disabled="speech.loading"
        aria-label="Position in this block"
        @input="onSeek"
      />
      <span class="time">
        {{
          speech.loading ? 'Preparing…' : `${clock(speech.currentTime)} / ${clock(speech.duration)}`
        }}
      </span>
      <span class="block-count">
        {{ speech.playback.index + 1 }}/{{ speech.playback.blocks.length }}
      </span>
    </div>
    <div class="controls">
      <button
        type="button"
        aria-label="Previous block"
        title="Previous block"
        :disabled="speech.playback.index === 0"
        @click="goToBlock(speech.playback.index - 1)"
      >
        <MediaIcon name="previous" />
      </button>
      <button
        type="button"
        :aria-label="`Back ${speechSkipSeconds} seconds`"
        @click="skip(-speechSkipSeconds)"
      >
        −{{ speechSkipSeconds }}s
      </button>
      <button
        type="button"
        class="primary"
        :aria-label="speech.playing ? 'Pause' : 'Play'"
        :disabled="speech.loading"
        @click="togglePause"
      >
        <MediaIcon :name="speech.playing ? 'pause' : 'play'" />
      </button>
      <button
        type="button"
        :aria-label="`Forward ${speechSkipSeconds} seconds`"
        @click="skip(speechSkipSeconds)"
      >
        +{{ speechSkipSeconds }}s
      </button>
      <button
        type="button"
        aria-label="Next block"
        title="Next block"
        :disabled="speech.playback.index + 1 >= speech.playback.blocks.length"
        @click="goToBlock(speech.playback.index + 1)"
      >
        <MediaIcon name="next" />
      </button>
      <span class="spacer" />
      <button
        type="button"
        class="rate"
        aria-label="Reading speed"
        :title="`Reading speed, tap for ${nextRate()}×`"
        @click="setRate(nextRate())"
      >
        {{ speech.rate }}×
      </button>
      <button
        type="button"
        class="chain"
        :class="{ on: speech.chain }"
        :aria-pressed="speech.chain"
        aria-label="Keep reading"
        :title="speech.chain ? 'Continues to the next block' : 'Stops after this block'"
        @click="setChain(!speech.chain)"
      >
        <MediaIcon name="chain" />
      </button>
      <button type="button" aria-label="Stop reading" title="Stop" @click="stopSpeech">
        <MediaIcon name="stop" />
      </button>
    </div>
    <p v-if="speech.error" class="error" role="alert">{{ speech.error }}</p>
  </section>
</template>

<style scoped>
.speech-player {
  display: grid;
  gap: 0.35rem;
  padding: 0.6rem 0 0.5rem;
  border-top: 1px solid var(--border);
}

.progress {
  display: flex;
  align-items: center;
  gap: 0.6rem;
  font-size: 0.8rem;
  color: var(--text-muted);
  font-variant-numeric: tabular-nums;
}

.progress input {
  flex: 1;
  min-width: 0;
  accent-color: var(--accent);
}

.controls {
  display: flex;
  align-items: center;
  gap: 0.4rem;
}

.controls button {
  display: inline-grid;
  place-items: center;
  padding: 0.25rem 0.55rem;
  font-variant-numeric: tabular-nums;
}

.spacer {
  flex: 1;
}

.rate {
  min-width: 3.2rem;
}

.chain {
  color: var(--text-muted);
}

.chain.on {
  color: var(--accent);
  border-color: var(--accent);
  background: var(--accent-soft);
}

.error {
  margin: 0;
  color: var(--danger);
  font-size: 0.85rem;
}
</style>
