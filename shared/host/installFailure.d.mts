// Types for installFailure.mjs: why adding a machine failed, and its one action.
export type FailureAction =
  | { kind: 'retry' }
  | { kind: 'wait' }
  | { kind: 'copy'; label: string; text: string }
  | { kind: 'daemon'; label: string }
  | { kind: 'account'; label: string }
  | { kind: 'ssh'; label: string };
export type FailureCause =
  | 'name'
  | 'route'
  | 'timeout'
  | 'remoteLoginOff'
  | 'keyOnly'
  | 'hostKeyChanged'
  | 'wrongPassword'
  | 'declined'
  | 'other';
export type Failure = { title: string; reason: string; action: FailureAction; cause: FailureCause; fingerprint?: string };
export function explainFailure(o: {
  step: string;
  output: string;
  target: string;
  destination: string;
  rolledBack?: boolean;
  publicKey?: string;
}): Failure;
export function explainBootFailure(error: string): Failure | null;
/** One line of an add: `index` of `total` phases, an upload's bytes in `progress`, `stalled` after 30 s without a change, `notice` what MoPilot does on its own. */
export type InstallStep = {
  id: string;
  label: string;
  state: string;
  output: string;
  index?: number;
  total?: number;
  progress?: { done: number; total: number };
  stalled?: boolean;
  notice?: string;
};
