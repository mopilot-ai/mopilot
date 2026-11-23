// What belongs to one harness in the pickers and Settings pages: its mark, how it signs in, its own
// wording and the rows only it has. Components outside this folder look a harness up here instead of
// asking which one it is (tests/boundary.test.ts); what a chat can do comes from useCaps, not from here.
import type { ComponentType, ReactElement } from 'react';
import type { HarnessId, HarnessStatus } from '../../harness/types';
import type { HarnessBinary } from '../../lib/cliSource';
import type { BillingProps } from '../pages/settings/BillingRow';
import { claudeParts } from './claude/parts';
import { codexParts } from './codex/parts';

export interface HarnessParts {
  Icon(p: { size: number }): ReactElement;
  /** Start the CLI's own login: Sage never sees the credentials. In a chat it signs in that chat's own login (D-43). */
  signIn(chatId?: string | null): void;
  signInLabel: string;
  /** Buttons beside Sign in on a signed-out row of the picker. */
  SignedOutActions?(): ReactElement;
  /** Under a harness the picker can't find. */
  missingHint: string;
  /** The Fast row's description in the + menu. */
  fastDesc: string;
  /** The Fast button's tooltip while Fast can be used; null: the plain Enable / Disable. */
  fastTip: string | null;
  /** Under Usage when the harness has reported none. */
  usageHint: string;
  /** A harness page's header: a button beside its name (Claude Code's Re-check). */
  CardAction?(): ReactElement;
  /** Under the account card: a sign-in it started that runs in the page (Claude Code's login terminal). */
  LoginTerm?: ComponentType;
  /** Profile menu: fetch current account usage whenever the menu opens, bypassing any freshness cache. */
  refreshUsage?(): Promise<void>;
  /** Profile menu: "Add account" starts the login itself, even with no account yet. */
  addsAccountDirectly?: boolean;
  /** A banner above the chat while something about this harness needs the user (its login lapsed). */
  Banner?(): ReactElement | null;
  /** The Plugins and Customize pages' tab for this harness; none: the Codex catalog. */
  Customize?(p: { tab: string }): ReactElement;
  /** What it pays with: the Pay with row's and the Use an API key action's state and actions. */
  useBilling(): BillingProps;
  /** Move on to another subscription of the same provider when one runs out; the setter rejects when the write fails. */
  useAutoSwitch(): [boolean, (on: boolean) => Promise<unknown>];
  /** The binary its chats run, as its Version row reads it, so the page header names its install the same way. */
  useBinary(st: HarnessStatus): HarnessBinary;
}

// read when used: each harness's parts module imports this one back, so it may not have loaded yet when this one does
export const PARTS: Record<HarnessId, HarnessParts> = {
  get codex() {
    return codexParts;
  },
  get claude() {
    return claudeParts;
  },
};
