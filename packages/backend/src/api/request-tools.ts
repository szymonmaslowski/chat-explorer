import { z } from 'zod';
import { requestToolFields as fields } from '@chat-explorer/shared/request-tools.js';
import type { RequestAction } from '@chat-explorer/shared/requests.js';
import { StoreError } from '../store/errors.js';
import { newPrefixedId } from '../store/ids.js';
import {
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

export type RequestToolArgs = {
  [Name in keyof typeof requestToolShapes]: z.infer<z.ZodObject<(typeof requestToolShapes)[Name]>>;
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

// Checks a tool's arguments, as the terminal sends them over HTTP, and makes its action.
export function actionFromTool(tool: string, args: unknown): RequestAction {
  if (!(tool in coordinationActions)) {
    throw new StoreError('not_found', `There is no request tool ${tool}.`);
  }
  const name = tool as CoordinationTool;
  const parsed = z.object(requestToolShapes[name]).parse(args);
  return (coordinationActions[name] as unknown as (input: unknown) => RequestAction)(parsed);
}
