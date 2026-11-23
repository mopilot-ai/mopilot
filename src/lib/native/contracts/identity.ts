// Native bridge account, provider identity and MoPilot gateway contracts.
import type { AccountsState, ClaudeAccountsState } from '../../../../shared/model/native';
export type {
  AccountLimits,
  AccountsState,
  ClaudeAccountsState,
  ClaudeManagedAccount,
  ManagedAccount,
} from '../../../../shared/model/native';

export type ClaudeAccountsEvent =
  | { type: 'changed'; state: ClaudeAccountsState }
  | { type: 'notice'; kind: 'signedIn'; id: string; email: string | null }
  | { type: 'notice'; kind: 'duplicate'; email: string | null }
  /** an added login's token is another account (`email`) than the one it was added as */
  | { type: 'notice'; kind: 'otherAccount'; id: string; email: string | null; addedAs: string | null };

export type AccountsEvent =
  | { type: 'changed'; state: AccountsState }
  | { type: 'notice'; kind: 'switched'; reason: 'limit' | 'expired'; from: string | null; to: string | null; threadId?: string | null }
  | { type: 'notice'; kind: 'exhausted' }
  | { type: 'notice'; kind: 'mopilotSignedOut' }
  | { type: 'notice'; kind: 'resume'; threadId: string; from: string | null; to: string | null }
  | {
      type: 'notice';
      kind: 'moved';
      reason: 'limit' | 'expired' | 'unavailable';
      from: string | null;
      to: string | null;
      threadId?: string | null;
    }
  | { type: 'notice'; kind: 'expired'; id: string; email: string | null }
  | { type: 'notice'; kind: 'signedIn'; email: string | null; added: boolean; mismatch: string | null }
  | { type: 'notice'; kind: 'loginFailed'; error: string };

/** Who pays for a turn (electron/identity/contract/registry.cjs). */
export type Billing = 'subscription' | 'apiKey' | 'credits';

export interface ProviderProfile {
  id: string;
  label: string;
  wires: string[];
  baseUrl: string | null;
  firstParty: boolean;
}

/** One credential on one harness. `account` is the id the harness's account list uses. */
export interface Instance {
  id: string;
  harness: 'codex' | 'claude';
  account: string;
  provider: string;
  kind: 'cliLogin' | 'harnessAuth' | 'sageKey';
  billing: Billing;
  label: string | null;
  /** unavailable: a basic harness being checked, unsupported or switched off */
  status: 'ok' | 'expired' | 'signedOut' | 'unavailable';
  active: boolean;
}

/** What the MoPilot gateway serves for one model at a price (web/lib/gateway/caps.ts). */
export interface MoPilotModelCaps {
  wires: string[];
  fast: boolean;
  service_tiers: string[];
  drops: string[];
}

export type MoPilotStatus = {
  signedIn: boolean;
  signingIn: boolean;
  /** internal: a staff account, which may use the dogfood update channel */
  /** features: the closed-alpha features the server invited this account to (e.g. 'momo') */
  user: { id: string; email: string; name?: string | null; image?: string | null; internal?: boolean; features?: string[] } | null;
  /** when the server last answered for the account in this run (ms), null until then */
  checkedAt?: number | null;
  /** spendable credits (balance minus in-flight reservations); null until loaded */
  balanceMicros: number | null;
  shareUsageData: boolean | null;
  /** the gateway's capability table by model (its drops, wires, tiers); null until loaded */
  modelCaps: Record<string, MoPilotModelCaps> | null;
  /** a build without the MoPilot service (electron/identity/mopilot.cjs NoMoPilotAccount): never signed in */
  unavailable?: true;
};
