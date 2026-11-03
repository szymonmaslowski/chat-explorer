import { describe, expect, it, vi } from 'vitest';
import { speechText } from '../src/speech/announcements.js';
import { chooseVoice } from '../src/speech/voices.js';
import { createFakeEngine, createTestApp, createTestSpeaker, seedConversation } from './helpers.js';

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
      messageId: 'm',
      content,
      block: { kind: 'text', text: 'Pierwszy.' },
      signal,
    });
    await speaker.speak({ messageId: 'm', content, block: { kind: 'diagram' }, signal });
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

describe('engines and the cache', () => {
  const polish = { language: 'pl', voices: [zosia], preferredVoice: null };
  const signal = new AbortController().signal;
  const text = (words: string) => ({ kind: 'text' as const, text: words });

  it('reads with the first engine that speaks the language, and the next one otherwise', async () => {
    const chatterbox = createFakeEngine('chatterbox', { languages: ['en'] });
    const say = createFakeEngine('say');
    const { speaker } = createTestSpeaker(polish, [chatterbox, say]);
    const spoken = await speaker.speak({
      messageId: 'm',
      content: 'Tak.',
      block: text('Tak.'),
      signal,
    });
    expect(spoken.contentType).toBe('audio/mp4');
    expect(chatterbox.spoken).toEqual([]);
    expect(say.spoken).toEqual([{ text: 'Tak.', voice: zosia.identifier }]);
  });

  it('renders a block once and plays it from the cache after', async () => {
    const { speaker, spoken } = createTestSpeaker();
    const request = { messageId: 'm', content: 'Hello.', block: text('Hello.'), signal };
    await speaker.speak(request);
    const again = await speaker.speak(request);
    expect(new TextDecoder().decode(again.audio)).toBe('say:Hello.');
    expect(spoken).toHaveLength(1);
  });

  it('renders a new answer ahead, block by block, for a slow engine', async () => {
    const chatterbox = createFakeEngine('chatterbox', { languages: ['en'] });
    const { speaker } = createTestSpeaker(undefined, [chatterbox]);
    const content = 'First part.\n\n```ts\nconst a = 1;\n```\n\nLast part.';
    await speaker.prepare('m', content);
    await vi.waitFor(() => expect(chatterbox.spoken).toHaveLength(3));
    expect(chatterbox.spoken.map(({ text }) => text)).toEqual([
      'First part.',
      'Code block, TypeScript, 1 line.',
      'Last part.',
    ]);

    const played = await speaker.speak({
      messageId: 'm',
      content,
      block: text('Last part.'),
      signal,
    });
    expect(played.contentType).toBe('audio/mpeg');
    expect(chatterbox.spoken).toHaveLength(3);
  });

  it('does not render ahead for a fast engine', async () => {
    const { speaker, spoken } = createTestSpeaker();
    await speaker.prepare('m', 'One.\n\nTwo.');
    expect(spoken).toEqual([]);
  });

  it('renders a block someone waits for first, then the rest of that answer', async () => {
    const chatterbox = createFakeEngine('chatterbox', { languages: ['en'], held: true });
    const { speaker } = createTestSpeaker(undefined, [chatterbox]);
    await speaker.prepare('older', 'Older one.\n\nOlder two.');
    await speaker.prepare('newer', 'Newer one.\n\nNewer two.\n\nNewer three.');
    await vi.waitFor(() => expect(chatterbox.spoken).toHaveLength(1));

    const waiting = speaker.speak({
      messageId: 'newer',
      content: 'Newer one.\n\nNewer two.\n\nNewer three.',
      block: text('Newer two.'),
      signal,
    });
    for (let finished = 1; finished < 5; finished++) {
      chatterbox.finishNext();
      await vi.waitFor(() => expect(chatterbox.spoken).toHaveLength(finished + 1));
    }
    chatterbox.finishNext();
    expect(new TextDecoder().decode((await waiting).audio)).toBe('chatterbox:Newer two.');
    expect(chatterbox.spoken.map(({ text }) => text)).toEqual([
      'Older one.',
      'Newer two.',
      'Newer one.',
      'Newer three.',
      'Older two.',
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
    expect(await response.text()).toBe('say:Table, 2 columns, 4 rows.');
    expect(spoken).toEqual([{ text: 'Table, 2 columns, 4 rows.', voice: daniel.identifier }]);
  });

  it('reads text that is not a message yet', async () => {
    const { request, spoken } = createTestApp();
    const response = await request('/api/speech', {
      method: 'POST',
      json: { draft: 'A comment still being written.', block: { kind: 'diagram' } },
    });
    expect(response.status).toBe(200);
    expect(spoken).toEqual([{ text: 'Diagram.', voice: daniel.identifier }]);
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
