// Typed PR monitor bridge shared by chat controls on every harness.
export interface PrContinuation {
  when: 'checks_pass' | 'merged';
  message: string;
}
export interface PrMonitorState {
  continuation?: PrContinuation | null;
  chatId: string;
  url: string;
  autoFix: boolean;
  addressComments: boolean;
  uncertain: boolean;
  limited: boolean;
  message?: string;
  error?: string | null;
  pr?: {
    title: string;
    state: string;
    pending: number;
    failed: number;
    headRefName: string;
    baseRefName: string;
    /** The head commit this read saw: a merge is pinned to it. */
    head?: string;
    /** GitHub's `mergeable` and `mergeStateStatus`, which the merge gate reads (shared/prMergeGate.mjs). */
    mergeable?: string;
    mergeState?: string;
    /** The PRs this one is stacked on, nearest first (its base branch's PR, then that one's); absent before a read. */
    parents?: PrParent[];
    /** Why the stack could not be read this time; the cards then show the last stack read. */
    stackError?: string;
  };
}
/** A PR the tracked one is stacked on, with its own state and CI counts. */
export interface PrParent {
  url: string;
  title: string;
  state: string;
  pending: number;
  failed: number;
  headRefName: string;
  baseRefName: string;
}
export interface PrStackCandidate {
  url: string;
  title: string;
  headRefName: string;
  baseRefName: string;
}
export interface PrMonitorPatch {
  url?: string;
  autoFix?: boolean;
  addressComments?: boolean;
  retry?: boolean;
  continuation?: PrContinuation | null;
}
/** The create form's starting values, or why the folder cannot have a pull request yet. */
export type PrDraft =
  | { status: 'draft'; branch: string; base: string; stacked: boolean; title: string; body: string; commits: number }
  | PrRefusal;
export interface PrRefusal {
  status: 'refused';
  reason: string;
  /** The sentence to show, written by main. */
  text: string;
}
export interface PrCreateInput {
  title: string;
  body: string;
  base: string;
  branch: string;
}
/** `web`: gh could not create it here and opened GitHub's form instead, for the reason in `why`. */
export type PrCreateResult = { status: 'created' | 'exists'; url: string; bound: boolean } | { status: 'web'; why: string } | PrRefusal;
/** `accepted`: GitHub took the merge but the pull request is not merged yet (a merge queue); never shown as merged. */
export type PrMergeResult = { status: 'merged'; method: string } | { status: 'accepted'; text: string } | PrRefusal;
declare module '../native' {
  interface NativeApi {
    prMonitor: {
      snapshot(chatId: string): Promise<PrMonitorState | null>;
      configure(chatId: string, patch: PrMonitorPatch): Promise<PrMonitorState>;
      refresh(chatId: string): Promise<PrMonitorState | null>;
      stackCandidates(chatId: string, url: string): Promise<PrStackCandidate[]>;
      stack(chatId: string, url: string, parentUrl: string): Promise<void>;
      createDraft(chatId: string): Promise<PrDraft>;
      create(chatId: string, input: PrCreateInput): Promise<PrCreateResult>;
      /** Merges only the head commit named: a click made on an older read is refused. */
      merge(chatId: string, url: string, head: string): Promise<PrMergeResult>;
      onChanged(cb: (chatId: string) => void): () => void;
    };
  }
}
