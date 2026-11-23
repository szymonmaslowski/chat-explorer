import { z } from 'zod';
import { claudeModels } from '@chat-explorer/shared/models.js';
import { registryNames } from '@chat-explorer/shared/network.js';
import type { RequestAction } from '@chat-explorer/shared/requests.js';

// The shapes of requested actions, as Claude sends them and as the user edits them on the card.

export const awarenessSchema = z.enum(['aware', 'separate']);
export const modelSchema = z.enum(claudeModels).nullable();
export const hostsSchema = z.array(z.string());
export const registriesSchema = z.array(z.enum(registryNames));
export const credentialsSchema = z.array(z.string());

export const boardInputSchema = z.object({
  action: z.enum(['add_column', 'rename_column', 'delete_column', 'move_column', 'move_fork']),
  column: z.string().nullable().optional(),
  name: z.string().optional(),
  afterColumn: z.string().nullable().optional(),
  forkId: z.string().optional(),
  afterForkId: z.string().nullable().optional(),
});

export const newNoteSchema = z.object({
  topic: z.string().optional(),
  description: z.string().optional(),
  category: z.string().optional(),
});

export const forkSettingsChangesSchema = z.object({
  title: z.string().optional(),
  awareness: awarenessSchema.optional(),
  coding: z.boolean().optional(),
  model: modelSchema.optional(),
  hosts: hostsSchema.optional(),
  registries: registriesSchema.optional(),
  credentials: credentialsSchema.optional(),
});

export const requestActionSchema: z.ZodType<RequestAction> = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('fork'),
    forkId: z.string(),
    title: z.string(),
    brief: z.string(),
    awareness: awarenessSchema,
    coding: z.boolean(),
    model: modelSchema,
    hosts: hostsSchema,
    registries: registriesSchema,
    credentials: credentialsSchema,
  }),
  z.object({ kind: z.literal('message'), forkId: z.string(), text: z.string() }),
  z.object({
    kind: z.literal('fork_settings'),
    forkId: z.string(),
    changes: forkSettingsChangesSchema,
  }),
  z.object({
    kind: z.literal('note_group'),
    groupId: z.string(),
    name: z.string(),
    checklist: z.boolean(),
  }),
  z.object({
    kind: z.literal('notes'),
    groupId: z.string(),
    notes: z.array(newNoteSchema),
    sourceMessageId: z.string().nullable(),
  }),
  z.object({
    kind: z.literal('note_update'),
    noteId: z.string(),
    topic: z.string().optional(),
    description: z.string().optional(),
    category: z.string().nullable().optional(),
    checked: z.boolean().optional(),
  }),
  z.object({ kind: z.literal('note_group_change'), noteId: z.string(), groupId: z.string() }),
  z.object({
    kind: z.literal('note_category'),
    groupId: z.string(),
    from: z.string(),
    to: z.string().nullable(),
  }),
  z.object({ kind: z.literal('note_deletion'), noteId: z.string() }),
  z.object({ kind: z.literal('board'), input: boardInputSchema }),
]);

export const requestDecisionSchema = z.object({
  decision: z.enum(['approve', 'reject']),
  items: z
    .array(
      z.object({ id: z.string(), selected: z.boolean(), action: requestActionSchema.optional() }),
    )
    .optional(),
  reason: z.string().nullable().optional(),
});
