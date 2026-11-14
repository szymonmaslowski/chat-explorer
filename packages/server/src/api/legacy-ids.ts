import { withPrefix, type PrefixedKind } from '../shared/ids.js';

// Chat, fork and note ids from before they had prefixes still arrive: in old links, in notes and
// messages, from Claude sessions that saw them, from changes a page queued. An old id is the new
// one without its prefix, so the prefix is added before the request is routed.

const kindAfterPathSegment: Record<string, PrefixedKind> = {
  explorations: 'chat',
  forks: 'fork',
  notes: 'note',
};

const kindOfField: Record<string, PrefixedKind> = {
  explorationId: 'chat',
  forkId: 'fork',
  viewForkId: 'fork',
  noteId: 'note',
  afterNoteId: 'note',
};

type Json = string | number | boolean | null | Json[] | { [key: string]: Json };

function prefixPath(pathname: string) {
  const segments = pathname.split('/');
  return segments
    .map((segment, index) => {
      const kind = kindAfterPathSegment[segments[index - 1] ?? ''];
      return kind ? withPrefix(kind, segment) : segment;
    })
    .join('/');
}

function prefixFields(value: Json): Json {
  if (Array.isArray(value)) return value.map(prefixFields);
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, field]) => {
      const kind = kindOfField[key];
      return [
        key,
        kind && typeof field === 'string' ? withPrefix(kind, field) : prefixFields(field),
      ];
    }),
  );
}

const isJson = (request: Request) =>
  request.headers.get('content-type')?.includes('application/json') === true;

function prefixedJson(text: string) {
  try {
    const parsed = JSON.parse(text) as Json;
    const prefixed = JSON.stringify(prefixFields(parsed));
    return prefixed === JSON.stringify(parsed) ? null : prefixed;
  } catch {
    return null;
  }
}

export async function withLegacyIdsPrefixed(request: Request) {
  const url = new URL(request.url);
  const pathname = prefixPath(url.pathname);
  const json = isJson(request) ? await request.clone().text() : null;
  const prefixedBody = json === null ? null : prefixedJson(json);
  if (pathname === url.pathname && prefixedBody === null) return request;
  url.pathname = pathname;
  const hasBody = request.method !== 'GET' && request.method !== 'HEAD';
  const headers = new Headers(request.headers);
  headers.delete('content-length');
  return new Request(url, {
    method: request.method,
    headers,
    body: hasBody ? (prefixedBody ?? json ?? (await request.arrayBuffer())) : null,
    signal: request.signal,
  });
}
