import { z } from 'zod';
import { requestToolFields as fields } from '@chat-explorer/shared/request-tools.js';
import type { RequestAction } from '@chat-explorer/shared/requests.js';
import { StoreError } from '../store/errors.js';
import { newId, newPrefixedId } from '../store/ids.js';
import {
  boardInputSchema,
  newNoteSchema,
  credentialsSchema,
  hostsSchema,
  modelSchema,
  registriesSchema,
} from './request-schemas.js';

// The arguments of each request tool, as a fork's Claude and the terminal send them, and the
// action each one asks for.

const settingsShape = {
  aware: z.boolean().optional().describe(fields.aware),
  coding: z.boolean().optional().describe(fields.coding),
  model: modelSchema.optional().describe(fields.model),
  hosts: hostsSchema.optional().describe(fields.hosts),
  registries: registriesSchema.optional().describe(fields.registries),
  credentials: credentialsSchema.optional().describe(fields.credentials),
};

export const requestToolShapes = {
  request_fork: {
    title: z.string().min(1).describe(fields.title),
    brief: z.string().min(1).describe(fields.brief),
    ...settingsShape,
  },
  request_message: {
    forkId: z.string(),
    text: z.string().min(1),
  },
  request_fork_settings: {
    forkId: z.string(),
    title: z.string().optional().describe(fields.title),
    ...settingsShape,
  },
};

// Writing notes and changing the board are requests too, for every fork, with the arguments the
// tools always had.
export const noteToolShapes = {
  add_note_group: { name: z.string().optional(), checklist: z.boolean().optional() },
  add_notes: {
    groupId: z.string(),
    notes: z.array(newNoteSchema).min(1),
    sourceMessageId: z.string().optional(),
  },
  update_note: {
    noteId: z.string(),
    topic: z.string().optional(),
    description: z.string().optional(),
    category: z.string().nullable().optional(),
    checked: z.boolean().optional(),
  },
  change_note_group: { noteId: z.string(), groupId: z.string() },
  rename_note_category: { groupId: z.string(), from: z.string(), to: z.string().nullable() },
  request_note_deletion: { noteId: z.string() },
  arrange_board: boardInputSchema.shape,
};

type Shapes = typeof requestToolShapes & typeof noteToolShapes;
export type RequestToolArgs = {
  [Name in keyof Shapes]: z.infer<z.ZodObject<Shapes[Name]>>;
};

const awareness = (aware: boolean | undefined) =>
  aware === undefined ? undefined : aware ? ('aware' as const) : ('separate' as const);

export const coordinationActions = {
  request_fork: (args: RequestToolArgs['request_fork']): RequestAction => ({
    kind: 'fork',
    forkId: newPrefixedId('fork'),
    title: args.title.trim(),
    brief: args.brief,
    awareness: awareness(args.aware) ?? 'aware',
    coding: args.coding ?? false,
    model: args.model ?? null,
    hosts: args.hosts ?? [],
    registries: args.registries ?? [],
    credentials: args.credentials ?? [],
  }),
  request_message: (args: RequestToolArgs['request_message']): RequestAction => ({
    kind: 'message',
    forkId: args.forkId,
    text: args.text,
  }),
  request_fork_settings: (args: RequestToolArgs['request_fork_settings']): RequestAction => ({
    kind: 'fork_settings',
    forkId: args.forkId,
    changes: Object.fromEntries(
      Object.entries({
        title: args.title,
        awareness: awareness(args.aware),
        coding: args.coding,
        model: args.model,
        hosts: args.hosts,
        registries: args.registries,
        credentials: args.credentials,
      }).filter(([, value]) => value !== undefined),
    ),
  }),
};

export type CoordinationTool = keyof typeof coordinationActions;
export const coordinationTools = Object.keys(coordinationActions) as CoordinationTool[];

const defined = <Values extends object>(values: Values) =>
  Object.fromEntries(Object.entries(values).filter(([, value]) => value !== undefined));

export const noteActions = {
  add_note_group: (args: RequestToolArgs['add_note_group']): RequestAction => ({
    kind: 'note_group',
    // Picked now, so notes requested in the same card can go into it.
    groupId: newId(),
    name: args.name?.trim() ?? '',
    checklist: args.checklist ?? false,
  }),
  add_notes: (args: RequestToolArgs['add_notes']): RequestAction => ({
    kind: 'notes',
    groupId: args.groupId,
    notes: args.notes,
    sourceMessageId: args.sourceMessageId ?? null,
  }),
  update_note: ({ noteId, ...changes }: RequestToolArgs['update_note']): RequestAction => ({
    kind: 'note_update',
    noteId,
    ...defined(changes),
  }),
  change_note_group: (args: RequestToolArgs['change_note_group']): RequestAction => ({
    kind: 'note_group_change',
    noteId: args.noteId,
    groupId: args.groupId,
  }),
  rename_note_category: (args: RequestToolArgs['rename_note_category']): RequestAction => ({
    kind: 'note_category',
    groupId: args.groupId,
    from: args.from,
    to: args.to,
  }),
  request_note_deletion: (args: RequestToolArgs['request_note_deletion']): RequestAction => ({
    kind: 'note_deletion',
    noteId: args.noteId,
  }),
  arrange_board: (args: RequestToolArgs['arrange_board']): RequestAction => ({
    kind: 'board',
    input: defined(args) as RequestToolArgs['arrange_board'],
  }),
};

export type NoteTool = keyof typeof noteActions;
export const noteTools = Object.keys(noteActions) as NoteTool[];

// Checks a tool's arguments, as the terminal sends them over HTTP, and makes its action.
export function actionFromTool(tool: string, args: unknown): RequestAction {
  if (tool in coordinationActions) {
    const name = tool as CoordinationTool;
    const parsed = z.object(requestToolShapes[name]).parse(args);
    return (coordinationActions[name] as unknown as (input: unknown) => RequestAction)(parsed);
  }
  if (tool in noteActions) {
    const name = tool as NoteTool;
    const parsed = z.object(noteToolShapes[name]).parse(args);
    return (noteActions[name] as unknown as (input: unknown) => RequestAction)(parsed);
  }
  throw new StoreError('not_found', `There is no request tool ${tool}.`);
}
