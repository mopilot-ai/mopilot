// Typed durable policy and worker identity shared by the main-repair coordinator and its runtime ports.
export type RepairPhase =
  | 'reserving'
  | 'reserved'
  | 'preparing'
  | 'prepared'
  | 'bound'
  | 'dispatching'
  | 'running'
  | 'waiting'
  | 'verifying'
  | 'uncertain'
  | 'failed'
  | 'lost'
  | 'complete';
export interface RepairPolicy {
  repo: string;
  root: string;
  enabled: boolean;
  generation: string;
  harness: string;
  settings: Record<string, unknown>;
  authorizedBy: string;
  authorizedAt: number;
}
export interface RepairJob {
  id: string;
  repo: string;
  issue: number;
  context: string;
  failedSha: string;
  url: string;
  runUrl: string;
  phase: RepairPhase;
  generation: string;
  claimant?: string;
  claimSha?: string;
  chatId?: string;
  cwd?: string;
  baseSha?: string;
  briefId: string;
  createdAt: number;
  updatedAt: number;
  attemptedAt?: number;
  releasePending?: boolean;
  error?: string;
  pr?: number | null;
  ownedInputId?: string;
  turnId?: string | null;
}
export interface RepairSnapshot {
  version: 1;
  policies: Record<string, RepairPolicy>;
  jobs: Record<string, RepairJob>;
}
