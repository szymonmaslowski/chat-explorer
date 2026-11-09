import '../suppress-warnings.js';
import { mkdirSync } from 'node:fs';
import { loadConfig } from '../config.js';
import { Database } from '../db/database.js';
import { EventBus } from '../store/event-bus.js';
import { ChatStore } from '../store/store.js';

const firstAnswer = `There are three common ways to cache API responses in a web app.

**In-memory cache.** The fastest option, but it lives inside one process. Every server instance has its own copy, so two users can see different data for a while.

**Shared cache (Redis or Memcached).** All instances read the same cache, so invalidation happens in one place. You pay a network round trip on every read, usually under a millisecond inside one data centre.

**HTTP caching.** Set \`Cache-Control\` and \`ETag\` headers and let browsers and CDNs do the work. It costs almost nothing to run, but you give up control: once a response is cached at the edge, you can only purge it through the CDN's API.

For most apps I'd start with HTTP caching for public data and a shared cache for per-user data.`;

const secondAnswer = `Cache invalidation gets hard when one write affects many cached keys.

A simple approach is to version the keys: store a version number per entity and include it in every key. A write bumps the version, and old keys expire on their own. You never delete anything explicitly.

\`\`\`ts
const key = \`user:\${userId}:v\${await getVersion(userId)}:profile\`;
\`\`\`

The cost is one extra read per lookup to fetch the version.`;

const forkAnswer = `With a CDN, purging by tag is the cleanest option. Tag each response with the entities it contains (for example \`Surrogate-Key: user-42 post-7\`), then purge by tag when an entity changes. Fastly and Cloudflare Enterprise both support it.`;

const config = loadConfig();
mkdirSync(config.home, { recursive: true });
const store = new ChatStore(new Database(config.databasePath), new EventBus());
const shimId = 'seed';

const { exploration, mainFork } = store.createExploration({
  title: 'Caching API responses',
  messages: [
    { role: 'user', content: 'What are my options for caching API responses?' },
    { role: 'assistant', content: firstAnswer },
  ],
});
store.attach({ explorationId: exploration.id, shimId, sessionId: 'seed-session', takeover: true });
store.updateExploration({
  explorationId: exploration.id,
  summary: 'Comparing in-memory, shared and HTTP caching, then invalidation.',
});

const answerId = store.readFork(mainFork.id).messages.at(-1)!.id;
const anchor = (quote: string) => {
  const start = firstAnswer.replace(/\*\*/g, '').indexOf(quote);
  return { quote, startOffset: start, endOffset: start + quote.length };
};

store.createComment(exploration.id, {
  messageId: answerId,
  viewForkId: mainFork.id,
  ...anchor('so invalidation happens in one place'),
  body: 'How do I handle invalidation when one write affects many keys?',
});
store.createComment(exploration.id, {
  messageId: answerId,
  viewForkId: mainFork.id,
  ...anchor('you can only purge it through the CDN'),
  body: 'How does purging work with a CDN?',
  type: 'fork',
});
store.submit(exploration.id, mainFork.id, 'Keep the answers short.');
store.deliverQueued(exploration.id);

for (const pending of store.pendingForks(exploration.id)) {
  store.addAssistantMessage({
    shimId,
    forkId: pending.forkId,
    inReplyTo: pending.inReplyTo,
    content: pending.isNewFork ? forkAnswer : secondAnswer,
  });
  if (pending.isNewFork) {
    store.updateForkSummary({
      forkId: pending.forkId,
      summary: 'Purging cached responses on a CDN',
    });
  }
}
store.updateForkSummary({
  forkId: mainFork.id,
  summary: 'Caching options and invalidation',
});

const latestAnswerId = store.readFork(mainFork.id).messages.at(-1)!.id;
const versionQuote = 'store a version number per entity';
const versionStart = secondAnswer.indexOf(versionQuote);
store.createComment(exploration.id, {
  messageId: latestAnswerId,
  viewForkId: mainFork.id,
  quote: versionQuote,
  startOffset: versionStart,
  endOffset: versionStart + versionQuote.length,
  body: 'Where would the version numbers live?',
});
store.detach(shimId);

console.log(`Seeded exploration ${exploration.id}: ${config.baseUrl}/e/${exploration.id}`);
