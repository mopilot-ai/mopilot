// window.native.superagent's types (Settings › Superagent, S1 watch only), merged into NativeApi; the calls are declared in electron/bridge/superagent.cjs.

export type SuperagentMode = 'off' | 'observe';
export interface SuperagentRule {
  id: string;
  name: string;
  line: string;
  /** false: S1 does not watch this rule's events yet */
  available: boolean;
  mode: SuperagentMode;
}
export interface SuperagentConfig {
  repo: string | null;
  allowed: string[];
  botLogin: string;
  paused: { all: boolean; github: boolean };
  rules: SuperagentRule[];
}
export interface SuperagentLogRow {
  id: string;
  at: number;
  outcome: 'would_accept' | 'would_ignore' | 'would_ask';
  verdict: string;
  /** one line: what the event was */
  what: string;
  /** why, in one line */
  reasonText: string;
  rule: string | null;
  mark: 'right' | 'wrong' | null;
  url: string | null;
}
export interface SuperagentStats {
  total: number;
  wouldAccept: number;
  marked: number;
  right: number;
  wrong: number;
  /** right over right and wrong, null until something is marked */
  precision: number | null;
}
/** How the running source's last poll went: `reason` says what failed (no token, a rate limit, GitHub down). */
export interface SuperagentHealth {
  state: 'ok' | 'unchanged' | 'limited' | 'error';
  reason?: string;
}
export type SuperagentSource =
  | { state: 'watching'; repo: string; health?: SuperagentHealth }
  | { state: 'stopped'; reason: 'off' | 'no_repo' | 'paused' | 'idle' | 'no_source' | 'error' };
export type SuperagentProblem = { code: 'off' | 'damaged' | 'newer' | 'failed'; message: string; setAside: string | null };
export type SuperagentState =
  | { ok: false; error: SuperagentProblem; source: SuperagentSource }
  | {
      ok: true;
      config: SuperagentConfig;
      log: SuperagentLogRow[];
      stats: SuperagentStats;
      reconcile: { source: string; externalId: string; committedAt: number }[];
      source: SuperagentSource;
    };

declare module '../native' {
  interface NativeApi {
    superagent: {
      state(): Promise<SuperagentState>;
      /** throws `invalid_repo` for anything but owner/name */
      setRepo(repo: string | null): Promise<SuperagentConfig>;
      /** throws `invalid_login` naming the entries that are not GitHub logins */
      setAllowed(logins: string[]): Promise<SuperagentConfig>;
      /** throws `auto_unavailable` for Auto: it arrives with the next phase */
      setRule(id: string, mode: SuperagentMode): Promise<SuperagentConfig>;
      setPaused(scope: 'all' | 'github', paused: boolean): Promise<SuperagentConfig>;
      mark(id: string, mark: 'right' | 'wrong' | null): Promise<SuperagentStats>;
      /** starts a fresh database after damage; throws `not_damaged` when there is nothing to replace */
      acknowledge(): Promise<true>;
      onChanged(cb: () => void): () => void;
    };
  }
}
