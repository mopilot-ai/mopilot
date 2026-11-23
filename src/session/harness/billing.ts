// Subscription ⇄ API key, per harness: what's available and how to flip it.
// Codex's state lives in the store (accounts); Claude Code's key state lives in the main process,
// so it is mirrored here and every place that changes it goes through `applyClaudeKey`.
import { identityKey } from '../../../shared/identityKey.mjs';
import { useEffect, useSyncExternalStore } from 'react';
import { native, type ClaudeApiKeyInfo } from '../../lib/native';
import { errorText, ignoring } from '../../lib/ignored';
import { chatFamily } from '../../store/chats';
import { get as getState, toast, useStore } from '../../store/core';
import { setCodexMode } from '../../store/accounts';
import type { AppState } from '../../store/state';
import { onlyChatStreams } from '../../harness/onlyChatStreams';
import { chatAccount, codexStatus, harnessAccounts, setChatAccount } from './select';
import { accountName, loginUnread } from '../../harness/accounts';
import { recheckClaude } from './claude';
import { HARNESS_LABEL, type HarnessId, type UsageWindow } from '../../harness/types';
import { percentLeft, resetAhead, tightestWindow, USAGE_STALE_MS, usedNow, windowLimited } from '../../harness/usageWindows';
import { loginUsage } from '../../harness/claudeUsage';
import { getMoPilot, useMoPilot } from '../../lib/mopilot';
import { billingOptions, type BillingMode } from '../../lib/billingModes';
import { getClaudeKey, publishClaudeKey, subscribeClaudeKey } from '../../harness/claudeKeyState';
import { limitChoice, mostLeft, onUnavailable, payPerUseText, sameLane, type LaneInstance } from '../../../shared/switch.mjs';

export type { BillingMode };

/** Never rejects: a read that fails keeps the last known key info, and the next refresh tries again. */
export function refreshClaudeKey(): Promise<void> {
  return native.claude.apiKey().then(publishClaudeKey).catch(ignoring("read Claude Code's API key setting"));
}

/** Run a key change in the main process, publish the result, and re-check the login with it. */
export async function applyClaudeKey(fn: () => Promise<ClaudeApiKeyInfo>) {
  publishClaudeKey(await fn());
  await recheckClaude();
}

export function useClaudeKey() {
  const k = useSyncExternalStore(subscribeClaudeKey, getClaudeKey);
  useEffect(() => {
    // cannot reject (refreshClaudeKey records its own failure)
    if (!getClaudeKey()) void refreshClaudeKey();
  }, []);
  // Signing out of MoPilot drops Claude back to the login in main; pick that up without a restart.
  const signedIn = useMoPilot().signedIn;
  useEffect(() => {
    if (!signedIn && getClaudeKey()?.mode === 'mopilot')
      refreshClaudeKey()
        .then(() => recheckClaude())
        // the harness status shows the login state either way; the next re-check asks again
        .catch(ignoring('re-check Claude Code after signing out of MoPilot'));
  }, [signedIn]);
  return k;
}

export interface Billing {
  mode: BillingMode;
  /** the other modes that can be switched to right now without any setup */
  options: BillingMode[];
  switchTo(mode: BillingMode): Promise<void>;
}

/** "Use MoPilot credits" for a harness that is signed out or has none set up: sign in to MoPilot if needed, then bill the credits. */
export async function payWithMoPilotCredits(h: HarnessId) {
  try {
    if (!getMoPilot().signedIn) {
      const r = await native.mopilot.signIn();
      if (!r.ok) return void (r.error && toast(r.error, 'error'));
    }
    if (h === 'codex') await setCodexMode('mopilot');
    else await applyClaudeKey(() => native.claude.setAuthMode('mopilot'));
  } catch (e) {
    toast(errorText(e), 'error');
  }
}

export function useBilling(h: HarnessId): Billing | null {
  const accounts = useStore((s) => s.accounts);
  const ck = useClaudeKey();
  const mopilotIn = useMoPilot().signedIn;
  if (h === 'codex') {
    const active = accounts.accounts.find((a) => a.id === accounts.active);
    const mode: BillingMode = active?.mopilot ? 'mopilot' : active?.kind === 'apiKey' ? 'apiKey' : 'subscription';
    const hasKey = accounts.accounts.some((a) => a.kind === 'apiKey' && !a.mopilot);
    const hasSub = accounts.accounts.some((a) => a.kind === 'chatgpt' && a.status === 'ok');
    // once signed in, MoPilot credits are an account row in the pool
    const credits = accounts.accounts.some((a) => a.mopilot);
    return {
      mode,
      options: billingOptions(mode, { subscription: hasSub, apiKey: hasKey, credits }),
      switchTo: (m) => (m === 'routed' ? Promise.resolve() : setCodexMode(m)),
    };
  }
  if (!ck) return null;
  const mode = ck.mode;
  // A Claude login can't be inspected from here, so "subscription" is offered whenever a key or credits are active.
  return {
    mode,
    options: billingOptions(mode, { subscription: true, apiKey: !!ck.set, credits: mopilotIn }),
    switchTo: (m) => applyClaudeKey(() => native.claude.setAuthMode(m)),
  };
}

/* ------------------------------------------------------------------ */
/* limit fallback                                                      */
/* ------------------------------------------------------------------ */
// When a subscription runs out and no other subscription of the same provider can take over, offer
// (never perform) a move to pay-per-use or to MoPilot credits (shared/switch.mjs). Checked whenever
// the store changes; each exhausted window is offered once.
const offered = new Set<string>();

/** The windows that ran out and haven't started over yet. */
const exhausted = (usage: { windows: UsageWindow[] } | null | undefined) => usage?.windows.filter(windowLimited) ?? [];
/**
 * Those of them read recently enough to ask about paying: an old reading (a cached answer the CLI gave when it
 * couldn't fetch) doesn't ask, a fresh one will. A window kept from an older reading is as old as that one.
 */
const freshlyExhausted = (usage: { windows: UsageWindow[]; at?: number | null } | null | undefined) => {
  const measured = (w: { at?: number }) => w.at ?? usage?.at;
  return exhausted(usage).filter((w) => !measured(w) || Date.now() - measured(w)! <= USAGE_STALE_MS);
};
const providerOf = (base: string | null | undefined, own: string) => {
  if (!base) return own;
  try {
    return `custom:${new URL(base).host}`;
  } catch {
    return `custom:${base}`;
  }
};
const reached = (windows: { usedPercent: number; resetsAt?: number | null }[] | undefined) => !!windows?.some(windowLimited);

/** A harness's instances as the switching contract sees them: the one in use, and all of them. */
export function limitInstances(
  h: HarnessId,
  s = getState(),
  key = getClaudeKey(),
  mopilot = getMoPilot().signedIn,
): { from: LaneInstance | null; candidates: LaneInstance[] } {
  if (h === 'codex') {
    // MoPilot credits on Codex are an account row once signed in
    const all: LaneInstance[] = s.accounts.accounts.map((a) => ({
      id: a.id,
      provider: a.mopilot ? 'mopilot' : a.kind === 'apiKey' ? providerOf(a.baseUrl, 'openai') : 'openai',
      billing: a.mopilot ? 'credits' : a.kind === 'apiKey' ? 'apiKey' : 'subscription',
      status: a.status === 'expired' ? 'expired' : 'ok',
      limited: !!a.limits?.reached && resetAhead(a.limits.resetsAt),
    }));
    return { from: all.find((a) => a.id === s.accounts.active) ?? null, candidates: all };
  }
  const logins: LaneInstance[] = s.claudeAccounts.accounts.map((a) => ({
    id: a.id,
    provider: 'anthropic',
    billing: /api.?key|console/i.test(a.authMethod ?? '') ? 'apiKey' : 'subscription',
    status: a.loggedIn ? 'ok' : 'signedOut',
    limited: reached(loginUsage(s.claudeUsage, s.claudeAccounts, a.id)?.windows),
  }));
  const from = logins.find((a) => a.id === s.claudeAccounts.active) ?? {
    id: 'default',
    provider: 'anthropic',
    billing: 'subscription',
    status: 'ok',
  };
  // the login with the most left first, as main picks one (an unread login counts as full)
  const left = (l: LaneInstance) => {
    const used = tightestWindow(loginUsage(s.claudeUsage, s.claudeAccounts, l.id)?.windows ?? []);
    const now = used && usedNow(used);
    return now == null ? 100 : percentLeft(now);
  };
  const candidates = mostLeft(logins, s.claudeAccounts.active, left);
  if (key?.set) candidates.push({ id: 'apiKey', provider: providerOf(key.baseUrl, 'anthropic'), billing: 'apiKey', status: 'ok' });
  if (mopilot) candidates.push({ id: 'mopilot', provider: 'mopilot', billing: 'credits', status: 'ok' });
  return { from, candidates };
}

/**
 * The accounts chats in use are pinned to on a harness, with those chats: each can run out while the
 * account in use has plenty left, and its chats then need the offer as much (design/multi-account R-8).
 */
function pinnedInUse(h: HarnessId, s: AppState): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const chatId of Object.keys(s.runtime)) {
    if (chatFamily(chatId) !== h) continue;
    const a = chatAccount(h, chatId, s);
    if (a?.pinned) out.set(a.id, [...(out.get(a.id) ?? []), chatId]);
  }
  return out;
}

function checkLimit(h: HarnessId) {
  const s = getState();
  // the same choice the settings row shows (Accounts & billing → When a limit is reached)
  const autoSwitch = (h === 'codex' ? s.accounts.autoSwitch : s.claudeAccounts.autoSwitch) !== false;
  if (limitChoice(autoSwitch, s.prefs.limitAsk?.[h]) === 'stop') return;
  // a login not read yet reads signed out, and the one that would take over is missed: ask once every login has been read
  if (h === 'claude' && s.claudeAccounts.accounts.some(loginUnread)) return;
  const { from, candidates } = limitInstances(h, s);
  const st = h === 'codex' ? codexStatus(s) : s.claude.status;
  // the account in use, from the harness status: only a subscription has a limit to run out of
  if (st.state === 'ready') offerPaidAccess(h, from, freshlyExhausted(st.usage), candidates, autoSwitch, null, []);
  const pinned = pinnedInUse(h, s);
  if (!pinned.size) return;
  const accounts = harnessAccounts(h, s).accounts;
  for (const [id, chats] of pinned) {
    const pin = candidates.find((c) => c.id === id);
    const acct = accounts.find((a) => a.id === id);
    if (id === from?.id || !pin || pin.billing !== 'subscription' || !acct) continue;
    offerPaidAccess(h, pin, freshlyExhausted(acct.usage), candidates, autoSwitch, accountName(acct), chats);
  }
}

/**
 * The chats an offer named that are still pinned to the account that ran out, read at the click, follow the new
 * billing: a chat the user pinned elsewhere since keeps that newer pin.
 */
function moveStillPinned(h: HarnessId, accountId: string | null, chats: string[]) {
  const s = getState();
  const still = chats.filter((c) => {
    const a = chatAccount(h, c, s);
    return !!a?.pinned && a.id === accountId;
  });
  return Promise.all(still.map((c) => setChatAccount(h, c, h === 'codex' ? s.accounts.active : null)));
}

/**
 * Offer (never perform) paid access for one subscription that ran out. `name` and `chats`: an account chats
 * are pinned to that isn't the one in use; taking the offer lets those chats follow the new billing.
 */
function offerPaidAccess(
  h: HarnessId,
  from: LaneInstance | null,
  full: ReturnType<typeof exhausted>,
  candidates: LaneInstance[],
  autoSwitch: boolean,
  name: string | null,
  chats: string[],
) {
  if (!full.length) return;
  const accountId = from?.id ?? null;
  // another subscription of the same provider takes over on its own; anything else is asked. With
  // auto-switch off none takes over, so paid access is what there is to ask about.
  const d = onUnavailable({
    from: from && { ...from, limited: true },
    candidates: autoSwitch ? candidates : candidates.filter((c) => !sameLane(from, c)),
  });
  if (d.action !== 'confirm' && d.action !== 'offer') return;
  const id = identityKey(h, accountId, ...full.map((w) => identityKey(w.label, String(w.resetsAt ?? w.resetsText ?? ''))));
  if (offered.has(id)) return;
  offered.add(id);
  const credits = d.to.billing === 'credits';
  const mode: BillingMode = credits ? 'mopilot' : 'apiKey';
  const who = name
    ? `${HARNESS_LABEL[h]} (${name}, pinned to ${chats.length === 1 ? 'a chat' : `${chats.length} chats`})`
    : HARNESS_LABEL[h];
  toast(credits || name ? `${who} has reached its subscription limit` : payPerUseText(h === 'codex' ? 'OpenAI' : 'Anthropic'), 'error', {
    duration: 12000,
    action: {
      label: credits ? 'Continue on MoPilot credits' : 'Continue with API key',
      run: () =>
        (h === 'codex' ? setCodexMode(mode) : applyClaudeKey(() => native.claude.setAuthMode(mode)))
          // the pinned chats leave the account that ran out for what was just chosen: a Codex chat is put on the
          // account now in use (unpinned, the relay would keep it where it was); a Claude key bills every login
          .then(() => moveStillPinned(h, accountId, chats))
          .then(() => toast(`${HARNESS_LABEL[h]} now bills ${credits ? 'MoPilot credits' : 'your API key'}`, 'success'))
          .catch((e) => toast(errorText(e), 'error')),
    },
  });
}

/** Start watching for exhausted subscriptions. Call once. */
export function startLimitWatch() {
  // cannot reject (refreshClaudeKey records its own failure)
  void refreshClaudeKey();
  useStore.subscribe((s, prev) => {
    if (onlyChatStreams(s, prev)) return;
    checkLimit('codex');
    checkLimit('claude');
  });
}
