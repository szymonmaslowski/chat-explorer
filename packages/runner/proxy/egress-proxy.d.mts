import type { Server } from 'node:http';
import type { Socket } from 'node:net';

export interface EgressProxyOptions {
  port?: number;
  policiesPath: string;
  logsPath: string;
  alwaysAllowed?: string[];
  toolsHost: string;
  lookup?: (host: string) => Promise<{ address: string; family: number }[]>;
  maxConnections?: number;
  connect?: (port: number, host: string, onConnect: () => void) => Socket;
}

export function isPublicAddress(address: string): boolean;
export function startEgressProxy(options: EgressProxyOptions): Promise<Server>;
