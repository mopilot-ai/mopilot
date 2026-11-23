// window.native.ledger's types (the request ledger, electron/ledger), merged into NativeApi; the calls are declared in electron/bridge/ledger.cjs.
export {};

/** One line of the request ledger (schema v1, electron/ledger/line.cjs): no prompt, reply, tool content, token or key. */
export interface LedgerLine {
  v: 1;
  t: string;
  chat?: string;
  harness: string;
  session?: string;
  turn?: string;
  /** The request's own id (Claude's message id, Codex's thread and running total), the one its harness's transcript keeps. */
  key?: string;
  account?: { id: string; email?: string; verified?: boolean };
  /** How the request is paid for. */
  pay?: LedgerPay;
  req?: string;
  served?: string;
  effort?: string;
  in?: number;
  out?: number;
  cacheRead?: number;
  cacheWrite?: number;
  reasoning?: number;
  outcome: 'ok' | 'retry' | 'error' | 'interrupted';
  status?: number;
  code?: string;
  error?: string;
}

export type LedgerPay = 'plan' | 'key' | 'gateway' | 'cloud' | 'routed' | 'unknown';

/** Usage of one day, harness, model and way of paying, with its cost at list price (shared/costSummary.mjs); null when unpriced. */
export interface LedgerUsageRow {
  day: string;
  harness: string;
  model: string | null;
  pay: LedgerPay | string;
  requests: number;
  in: number;
  out: number;
  cacheRead: number;
  cacheWrite: number;
  usd: number | null;
}

export interface LedgerSummary {
  rows: LedgerUsageRow[];
  /** Whether days older than the raw files' retention could be read. */
  rollup: 'ok' | 'unreadable';
  /** Raw days that could not be read: the summary leaves them out. */
  unread?: string[];
  /** Whether the usage imported from sessions run outside MoPilot could be read. */
  imported?: 'ok' | 'unreadable';
}

/** Files of one harness an import saw, those it read because they were new or changed, and those it could not read. */
export type LedgerImportFound = { files: number; read: number; failed: number };

/** How an import of outside sessions' usage went: Claude Code's transcripts and Codex's rollouts it found; or why it did not run. */
export type LedgerImportResult = { claude: LedgerImportFound; codex: LedgerImportFound } | { refused: 'off' | 'not-started' };

export interface LedgerFilter {
  limit?: number;
  harness?: string;
  account?: string;
  outcome?: string;
  chat?: string;
}

declare module '../native' {
  interface NativeApi {
    ledger: {
      /** The last lines matching the filter, newest first (at most 200 unless limit says otherwise). */
      recent(filter?: LedgerFilter): Promise<LedgerLine[]>;
      /** Usage and cost at list price from `from` to `to` (local day stems, both included; either open). */
      summary(range?: { from?: string; to?: string }): Promise<LedgerSummary>;
      /** Imports the usage of Claude Code and Codex sessions that ran outside MoPilot from their own transcripts and rollouts. */
      importOutside(): Promise<LedgerImportResult>;
      /** Opens the folder the ledger's day files are in. */
      reveal(): Promise<{ ok: boolean; error?: string }>;
    };
  }
}
