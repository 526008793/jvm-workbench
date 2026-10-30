import type { ArthasAttachProgress, DiagnosticTask } from './arthas';
import { z } from 'zod';

export const targetSchema = z.object({
  projectId: z.string().min(1),
  environmentId: z.string().min(1),
  serverId: z.string().min(1),
});
export const connectSchema = targetSchema.extend({
  binding: z.string(),
  rememberPassword: z.boolean().optional(),
  authentication: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('password'), password: z.string() }),
    z.object({ kind: z.literal('privateKey'), keyId: z.string().min(1), passphrase: z.string() }),
    z.object({ kind: z.literal('interactive') }),
    z.object({ kind: z.literal('savedPassword') }),
    z.object({ kind: z.literal('reuse'), connectionId: z.string().min(1) }),
  ]),
});
export const logRequestSchema = z.object({
  projectId: z.string().min(1),
  environmentId: z.string().min(1),
  serviceId: z.string().min(1),
  instanceIds: z.array(z.string()).min(1),
  mode: z.enum(['new', 'recent', 'since', 'range']),
  lines: z.number().int().nonnegative(),
  since: z.string(),
  until: z.string().optional(),
});
export type RemoteTarget = z.infer<typeof targetSchema>;
export type ConnectInput = z.infer<typeof connectSchema>;
export type LogRequest = z.infer<typeof logRequestSchema>;
export type ConnectionStatus =
  | 'connecting'
  | 'verifying-host'
  | 'authenticating'
  | 'awaiting-target'
  | 'ready'
  | 'closed'
  | 'error';
export interface ConnectionView extends RemoteTarget {
  id: string;
  kind: 'ssh' | 'jumpserver';
  status: ConnectionStatus;
  hostname?: string;
  terminalReady?: boolean;
  error?: string;
}
export interface Challenge {
  id: string;
  connectionId: string;
  kind: 'host' | 'keyboard';
  title: string;
  instruction: string;
  fingerprint?: string;
  prompts: { prompt: string; echo: boolean }[];
}
export interface ChallengeAnswer {
  connectionId: string;
  challengeId: string;
  answers: string[];
  acceptHost?: boolean;
}
export interface DockerContainer {
  id: string;
  name: string;
  image: string;
  status: string;
}
export type LogStatus =
  'starting' | 'running' | 'stopping' | 'stopped' | 'ended' | 'error' | 'unknown';
export interface LogTask {
  id: string;
  projectId: string;
  environmentId: string;
  serviceId: string;
  instanceId: string;
  serverId: string;
  containerName: string;
  containerId?: string;
  startedAt?: string;
  status: LogStatus;
  error?: string;
}
export interface LogRow {
  id: string;
  taskId: string;
  serviceId: string;
  instanceId: string;
  serverId: string;
  containerName: string;
  stream: 'stdout' | 'stderr' | 'pty';
  text: string;
  receivedAt: number;
  // Docker timestamp of the first physical line; continuation lines retain this event time.
  timestamp?: string;
}
export type RemoteEvent =
  | { type: 'arthas-attach-progress'; progress: ArthasAttachProgress }
  | { type: 'diagnostic-state'; task: DiagnosticTask }
  | { type: 'password-state'; target: RemoteTarget; remembered: boolean; error?: string }
  | { type: 'connection'; connection: ConnectionView }
  | { type: 'challenge'; challenge: Challenge }
  | { type: 'terminal'; connectionId: string; seq: number; data: string }
  | { type: 'logs'; rows: LogRow[] }
  | { type: 'log-state'; task: LogTask };

export type PasswordTarget = RemoteTarget & { binding: string };
export interface PasswordStatus {
  available: boolean;
  remembered: boolean;
}
