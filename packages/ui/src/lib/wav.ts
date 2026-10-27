export const whisperSampleRate = 16_000;

export function encodeWav(samples: Float32Array, sampleRate: number) {
  const dataBytes = samples.length * 2;
  const view = new DataView(new ArrayBuffer(44 + dataBytes));
  const writeAscii = (offset: number, text: string) => {
    for (const [index, character] of [...text].entries()) {
      view.setUint8(offset + index, character.charCodeAt(0));
    }
  };
  writeAscii(0, 'RIFF');
  view.setUint32(4, 36 + dataBytes, true);
  writeAscii(8, 'WAVEfmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeAscii(36, 'data');
  view.setUint32(40, dataBytes, true);
  for (const [index, sample] of samples.entries()) {
    view.setInt16(44 + index * 2, Math.max(-1, Math.min(1, sample)) * 0x7fff, true);
  }
  return view.buffer;
}

// whisper-cli reads WAV but not the WebM or MP4 that browsers record, so the page converts.
export async function toWav(recording: Blob) {
  const context = new AudioContext();
  try {
    const decoded = await context.decodeAudioData(await recording.arrayBuffer());
    const offline = new OfflineAudioContext(
      1,
      Math.ceil(decoded.duration * whisperSampleRate),
      whisperSampleRate,
    );
    const source = offline.createBufferSource();
    source.buffer = decoded;
    source.connect(offline.destination);
    source.start();
    const rendered = await offline.startRendering();
    return new Blob([encodeWav(rendered.getChannelData(0), whisperSampleRate)], {
      type: 'audio/wav',
    });
  } finally {
    void context.close();
  }
}
