import type { ClientRequest, IncomingMessage, RequestOptions, Server } from 'node:http';
import type { Socket } from 'node:net';

export interface EgressProxyOptions {
  port?: number;
  policiesPath: string;
  logsPath: string;
  alwaysAllowed?: string[];
  toolsHost: string;
  blockedHosts?: string[];
  lookup?: (host: string) => Promise<{ address: string; family: number }[]>;
  maxConnections?: number;
  connect?: (port: number, host: string, onConnect: () => void) => Socket;
  modelPort?: number;
  secretsPath: string;
  requestModel?: (
    options: RequestOptions,
    onResponse: (response: IncomingMessage) => void,
  ) => ClientRequest;
}

export function isPublicAddress(address: string): boolean;
export function startEgressProxy(
  options: EgressProxyOptions,
): Promise<{ forward: Server; model: Server }>;
