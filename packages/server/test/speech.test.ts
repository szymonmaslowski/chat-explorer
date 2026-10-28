import { describe, expect, it } from 'vitest';
import { speechText } from '../src/speech/announcements.js';
import { chooseVoice } from '../src/speech/voices.js';
import { createTestApp, createTestSpeaker, seedConversation } from './helpers.js';

const daniel = {
  identifier: 'com.apple.voice.compact.en-GB.Daniel',
  language: 'en-GB',
  quality: 1,
};
const samantha = {
  identifier: 'com.apple.voice.compact.en-US.Samantha',
  language: 'en-US',
  quality: 1,
};
const zosia = { identifier: 'com.apple.voice.compact.pl-PL.Zosia', language: 'pl-PL', quality: 1 };

describe('voice choice', () => {
  it('picks a regular voice for the language, the best quality first', () => {
    const ava = { identifier: 'com.apple.voice.premium.en-US.Ava', language: 'en-US', quality: 3 };
    const bells = {
      identifier: 'com.apple.speech.synthesis.voice.Bells',
      language: 'en-US',
      quality: 1,
    };
    expect(
      chooseVoice({ language: 'en', voices: [bells, daniel, ava, zosia], preferredVoice: null }),
    ).toEqual({ language: 'en', identifier: ava.identifier });
  });

  it("prefers the system's voice for the language among equals", () => {
    expect(
      chooseVoice({
        language: 'en',
        voices: [daniel, samantha],
        preferredVoice: samantha.identifier,
      }),
    ).toEqual({ language: 'en', identifier: samantha.identifier });
  });

  it('falls back to the default voice when none speaks the language', () => {
    expect(chooseVoice({ language: 'de', voices: [daniel], preferredVoice: null })).toEqual({
      language: 'de',
      identifier: null,
    });
  });
});

describe('speech text', () => {
  it('reads text as it is', () => {
    expect(speechText({ kind: 'text', text: 'Hello there.' }, 'en')).toBe('Hello there.');
  });

  it('announces code with its language and length', () => {
    expect(speechText({ kind: 'code', language: 'ts', lines: 12 }, 'en')).toBe(
      'Code block, TypeScript, 12 lines.',
    );
    expect(speechText({ kind: 'code', language: '', lines: 1 }, 'en')).toBe('Code block, 1 line.');
  });

  it('announces diagrams, tables and images', () => {
    expect(speechText({ kind: 'diagram' }, 'en')).toBe('Diagram.');
    expect(speechText({ kind: 'table', columns: 3, rows: 1 }, 'en')).toBe(
      'Table, 3 columns, 1 row.',
    );
    expect(speechText({ kind: 'image', description: 'Fork map' }, 'en')).toBe('Image: Fork map');
  });

  it('announces in Polish with Polish plurals', () => {
    expect(speechText({ kind: 'code', language: 'sh', lines: 2 }, 'pl')).toBe(
      'Blok kodu, shell, 2 linie.',
    );
    expect(speechText({ kind: 'table', columns: 5, rows: 22 }, 'pl')).toBe(
      'Tabela, 5 kolumn, 22 wiersze.',
    );
  });

  it('announces in English for other languages', () => {
    expect(speechText({ kind: 'diagram' }, 'de')).toBe('Diagram.');
    expect(speechText({ kind: 'code', language: 'go', lines: 3 }, null)).toBe(
      'Code block, Go, 3 lines.',
    );
  });
});

describe('speaker', () => {
  it('picks the voice from the language of the prose, for every block', async () => {
    const { speaker, inspected, spoken } = createTestSpeaker({
      language: 'pl',
      voices: [daniel, zosia],
      preferredVoice: null,
    });
    const content = 'Wydaje mi się, że to działa.\n\n```ts\nconst answer = 42;\n```';
    const signal = new AbortController().signal;
    await speaker.speak({
      content,
      block: { kind: 'text', text: 'Pierwszy.' },
      signal,
    });
    await speaker.speak({ content, block: { kind: 'diagram' }, signal });
    expect(inspected).toEqual([
      'Wydaje mi się, że to działa.\n\n ',
      'Wydaje mi się, że to działa.\n\n ',
    ]);
    expect(spoken).toEqual([
      { text: 'Pierwszy.', voice: zosia.identifier },
      { text: 'Diagram.', voice: zosia.identifier },
    ]);
  });
});

describe('speech API', () => {
  it('returns the audio for a block of a message', async () => {
    const { request, store, spoken } = createTestApp();
    const { answer } = seedConversation(store);
    const response = await request('/api/speech', {
      method: 'POST',
      json: { messageId: answer.id, block: { kind: 'table', columns: 2, rows: 4 } },
    });
    expect(response.headers.get('content-type')).toBe('audio/mp4');
    expect(await response.text()).toBe('audio:Table, 2 columns, 4 rows.');
    expect(spoken).toEqual([{ text: 'Table, 2 columns, 4 rows.', voice: daniel.identifier }]);
  });

  it('refuses an unknown message and empty text', async () => {
    const { request, store } = createTestApp();
    const { answer } = seedConversation(store);
    const unknown = await request('/api/speech', {
      method: 'POST',
      json: { messageId: 'missing', block: { kind: 'diagram' } },
    });
    expect(unknown.status).toBe(404);
    const empty = await request('/api/speech', {
      method: 'POST',
      json: { messageId: answer.id, block: { kind: 'text', text: '  ' } },
    });
    expect(empty.status).toBe(400);
  });
});
