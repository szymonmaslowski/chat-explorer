import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { NewMessage } from '../store/store.js';

type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image' }
  | { type: 'tool_result' }
  | { type: 'tool_use' }
  | { type: 'thinking' };

interface TranscriptRecord {
  type: string;
  uuid?: string;
  parentUuid?: string | null;
  logicalParentUuid?: string;
  subtype?: string;
  isSidechain?: boolean;
  isMeta?: boolean;
  isCompactSummary?: boolean;
  origin?: { kind?: string };
  promptSource?: string;
  aiTitle?: string;
  message?: { content: string | ContentBlock[] };
  attachment?: { type: string; prompt?: string; commandMode?: string };
}

export interface ParsedTranscript {
  title: string | null;
  messages: NewMessage[];
}

const ignoredPrefixes = [
  '<command-name>',
  '<command-message>',
  '<command-args>',
  '<local-command-stdout>',
  '<local-command-stderr>',
  '<local-command-caveat>',
  '<system-reminder>',
  '<task-notification>',
  '[Request interrupted',
];

const sessionIdPattern = /^[A-Za-z0-9-]+$/;

export function findTranscript(
  sessionId: string,
  claudeHome = process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude'),
) {
  if (!sessionIdPattern.test(sessionId)) return null;
  const projectsDirectory = join(claudeHome, 'projects');
  if (!existsSync(projectsDirectory)) return null;
  for (const project of readdirSync(projectsDirectory)) {
    const candidate = join(projectsDirectory, project, `${sessionId}.jsonl`);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

export function readTranscript(path: string) {
  return parseTranscript(readFileSync(path, 'utf8'));
}

export function parseTranscript(text: string): ParsedTranscript {
  const records = text
    .split('\n')
    .filter((line) => line.trim())
    .flatMap((line): TranscriptRecord[] => {
      try {
        return [JSON.parse(line)];
      } catch {
        return [];
      }
    });
  const title = records.findLast((record) => record.type === 'ai-title')?.aiTitle ?? null;
  const chain = truncateAtExploreChat(currentBranch(records));
  return { title, messages: toMessages(chain) };
}

// A rewind appends the new branch at the end of the file, so the last record is on the current branch.
function currentBranch(records: TranscriptRecord[]) {
  const byUuid = new Map(records.flatMap((record) => (record.uuid ? [[record.uuid, record]] : [])));
  const chain: TranscriptRecord[] = [];
  let current = records.findLast((record) => record.uuid !== undefined);
  while (current) {
    chain.push(current);
    const parentUuid =
      current.parentUuid ??
      (current.subtype === 'compact_boundary' ? current.logicalParentUuid : undefined);
    current = parentUuid ? byUuid.get(parentUuid) : undefined;
  }
  return chain.reverse();
}

function truncateAtExploreChat(chain: TranscriptRecord[]) {
  const invocation = chain.findLastIndex((record) => {
    const content = record.type === 'user' ? record.message?.content : undefined;
    return (
      typeof content === 'string' &&
      /<command-name>\/?[\w:-]*explore-chat<\/command-name>/.test(content)
    );
  });
  return invocation === -1 ? chain : chain.slice(0, invocation);
}

function toMessages(chain: TranscriptRecord[]) {
  const messages: NewMessage[] = [];
  for (const record of chain) {
    if (record.isSidechain) continue;
    const userText = userTextOf(record);
    if (userText) {
      messages.push({ role: 'user', content: userText });
      continue;
    }
    const assistantText = assistantTextOf(record);
    if (!assistantText) continue;
    const previous = messages.at(-1);
    if (previous?.role === 'assistant')
      previous.content = `${previous.content}\n\n${assistantText}`;
    else messages.push({ role: 'assistant', content: assistantText });
  }
  return messages;
}

function userTextOf(record: TranscriptRecord) {
  if (record.type === 'attachment') {
    const { attachment } = record;
    const isTypedPrompt =
      attachment?.type === 'queued_command' && attachment.commandMode === 'prompt';
    return isTypedPrompt ? keptText(attachment.prompt ?? '') : null;
  }
  if (record.type !== 'user' || record.isMeta || record.isCompactSummary) return null;
  if (record.origin?.kind === 'task-notification' || record.promptSource === 'system') return null;
  const content = record.message?.content;
  if (typeof content === 'string') return keptText(content);
  if (!content || content.some((block) => block.type === 'tool_result')) return null;
  const text = content
    .map((block) => (block.type === 'text' ? block.text : block.type === 'image' ? '[image]' : ''))
    .filter(Boolean)
    .join('\n\n');
  return keptText(text);
}

function assistantTextOf(record: TranscriptRecord) {
  if (record.type !== 'assistant') return null;
  const content = record.message?.content;
  if (!Array.isArray(content)) return null;
  const text = content
    .flatMap((block) => (block.type === 'text' ? [block.text.trim()] : []))
    .filter(Boolean)
    .join('\n\n');
  return text || null;
}

function keptText(text: string) {
  const trimmed = text.trim();
  if (!trimmed || ignoredPrefixes.some((prefix) => trimmed.startsWith(prefix))) return null;
  return trimmed;
}
