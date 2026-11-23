// Harness-agnostic views over the store: one status / model list / selection shape per harness.
// Codex's are derived from its existing state (conn, account, rateLimits, models, prefs.model…).
import { useMemo } from 'react';
import { addAccount, login, pinCodexChat, removeAccount, switchAccount } from '../../store/accounts';
import { chatFamily, newChatFamily } from '../../store/chats';
import { get as getState, patchRuntime, setPrefs, toast, toastFailure, useStore } from '../../store/core';
import { setChatConfig } from '../../store/projects';
import type { AppState } from '../../store/state';
import { native } from '../../lib/native';
import { codexChatSelection } from '../../harness/codexSettings';
import { localEffortChoice } from '../../harness/newChatEffort';
import { knownClaudeSettings, ownSetting } from '../../harness/claude/own';
import { incompatibleText } from '../../harness/codexCompat';
import { codexState } from '../../harness/codexState';
import { codexQuitText } from '../../harness/codexQuit';
import { addClaudeAccount, pinClaudeChat, reloginClaudeAccount, removeClaudeAccount, switchClaudeAccount } from './claude';
import { modelLabel } from '../../lib/format';
import { getMoPilot, useMoPilot } from '../../lib/mopilot';
import { sessionOf, useSessionField } from '../../store/session/useSession';
import { configuredSwitchModel } from '../../../shared/switchModel.mjs';
import { chatModelChoice, effectiveModel } from '../../../shared/modelChoice.mjs';
import { useChatCaps } from '../../store/session/useCaps';
import { whyText } from '../../harness/caps';
import { accountRowTab } from '../../lib/settingsNav';
import type { ChatConfig } from '../../lib/chatMeta';
import { harnessInfo } from '../../harness/registry';
import { chatAccount } from './chatAccount';
import { currentFamily, firstTierOf } from '../../harness/family';
import { claudeModelFor } from '../../harness/claudeTranslate';
import { claudeModelServed } from '../../../shared/mopilotCaps.mjs';
import { useClaudeKey } from './billing';
import { getClaudeKey } from '../../harness/claudeKeyState';
import { activeTier, codexTiers } from '../../harness/tiers';
import {
  claudeAccounts,
  claudeKeyForAll,
  codexAccounts,
  codexLimitSnapshot,
  type Account,
  type HarnessAccounts,
  type LimitSnapshotLike,
} from '../../harness/accounts';
import { userError } from '../../../shared/userError.mjs';
import {
  HARNESS_LABEL,
  type HarnessId,
  type HarnessModel,
  type HarnessStatus,
  type Selection,
  type UsageWindow,
} from '../../harness/types';
import type { HarnessFamily } from '../../harness/family';
import { windowLabel } from '../../harness/usageWindows';

export { windowLabel };
export { chatAccount, useChatAccount, type ChatAccount } from './chatAccount';
export { chatAccountLabel, pinnedElsewhere, switchAccountLabel } from '../../harness/chatAccountLabel';

function planLabel(planType: string | null | undefined) {
  if (!planType || planType === 'unknown') return 'ChatGPT';
  const name = planType.replace(/^self_serve_business_/, 'business ').replace(/_/g, ' ');
  return `ChatGPT ${name.replace(/\b\w/g, (c) => c.toUpperCase())}`;
}

export function codexStatus(s: AppState): HarnessStatus {
  const managed = s.accounts.accounts.length
    ? (s.accounts.accounts.find((a) => a.id === s.accounts.active) ?? s.accounts.accounts[0])
    : null;
  const apiKey = managed ? managed.kind === 'apiKey' : s.account?.type === 'apiKey';
  const state = codexState(s) ?? (apiKey ? 'apikey' : 'ready');
  const snap = managed ? managed.limits : codexLimitSnapshot(s.rateLimits);
  const windows: UsageWindow[] = [];
  for (const w of [snap?.primary, snap?.secondary])
    if (w)
      windows.push({ label: windowLabel(w.windowDurationMins), usedPercent: Math.round(w.usedPercent ?? 0), resetsAt: w.resetsAt ?? null });
  return {
    state,
    bin: state === 'missing' ? null : (s.codexBinInUse ?? s.codexBin),
    version: s.userAgent ? (/codex[^/]*\/([\d.]+[^\s]*)/i.exec(s.userAgent)?.[1] ?? null) : null,
    plan: apiKey
      ? 'API key'
      : managed
        ? planLabel(managed.planType)
        : s.account
          ? planLabel(s.account.planType ?? (snap as LimitSnapshotLike | null)?.planType)
          : null,
    email: managed ? managed.email : (s.account?.email ?? null),
    usage: windows.length ? { windows, at: managed?.limits?.at ?? Date.now() } : null,
    // a short line: the exit code and the app-server's stderr stay in connError for diagnostics, never on the row
    error:
      s.conn === 'error'
        ? s.codexQuit
          ? codexQuitText(s.codexQuit)
          : userError(s.connError, { who: HARNESS_LABEL.codex })
        : state === 'error'
          ? incompatibleText(s.codexCompat!)
          : null,
    ...(s.conn === 'idle' ? { idle: true } : {}),
  };
}

export function codexModels(s: AppState): HarnessModel[] {
  return s.models
    .filter((m) => !m.hidden)
    .map((m) => ({
      id: m.model,
      label: modelLabel(m.displayName),
      description: m.description,
      // 'ultra' (several agents) only where the model lists it (the luna models don't, X1)
      efforts: m.supportedReasoningEfforts.map((e) => e.reasoningEffort as string),
      defaultEffort: m.defaultReasoningEffort,
      // Fast is the "priority" service tier; a model may list others, each offered as it names it (D-57)
      fast: codexTiers(m).length > 0,
      tiers: codexTiers(m),
      isDefault: m.isDefault,
    }));
}

export const harnessStatus = (h: HarnessId, s: AppState = getState()) => (h === 'codex' ? codexStatus(s) : s.claude.status);
export const harnessModels = (h: HarnessId, s: AppState = getState()) => (h === 'codex' ? codexModels(s) : s.claude.models);

/**
 * A model's display name on a harness ("GPT-6.1 Sol") for places that kept only its id (a segment's
 * model): the label the harness's list gives it, else the id made readable as the list would.
 */
export function modelName(h: HarnessId, id: string, s: AppState = getState()): string {
  const models = harnessModels(h, s);
  const m = models.find((x) => x.id === (h === 'claude' ? claudeModelFor(id, models) : id));
  return m?.label ?? (h === 'codex' ? modelLabel(id) : id);
}

/**
 * The model list is still on its way: Claude Code is being detected, or Codex is starting or has not
 * answered its first model/list yet (it reads as ready before the list arrives). An empty list then
 * shows a loading row rather than "No models".
 */
export function useModelsLoading(h: HarnessId): boolean {
  return useStore((s) =>
    h === 'codex'
      ? s.conn === 'idle' || s.conn === 'connecting' || (s.conn === 'ready' && !s.modelsLoaded)
      : s.claude.status.state === 'detecting',
  );
}

export function selectionFor(h: HarnessId, s: AppState = getState()): Selection {
  if (h === 'claude') return s.prefs.claudeSelection;
  return { model: s.prefs.model, effort: s.prefs.effort, fast: s.prefs.serviceTier === 'priority' };
}

/** The chat's pending switch as code outside a render reads it (setSelection); a component passes the one its session hook read (#2847). */
const heldSwitch = (threadId: string | null | undefined) => (threadId ? sessionOf(threadId).pendingSwitch : null);

/** A Codex chat (not about to switch harness) keeps its own model, effort and Fast. */
const codexOwnsSelection = (h: HarnessId, threadId: string | null | undefined, pending: unknown) =>
  h === 'codex' && !!threadId && chatFamily(threadId) === 'codex' && !pending;

/** A Claude chat (not about to switch harness) keeps its own model and effort. */
const ownsSelection = (h: HarnessId, threadId: string | null | undefined, pending: unknown) =>
  h === 'claude' && !!threadId && chatFamily(threadId) === 'claude' && !pending;

/**
 * A Claude chat's own model and effort, read the way main runs its turns (electron/harness/claude/turnSettings.cjs): what
 * its session or a pick says, else what it saved (a key that is there, even null, wins), else the new-chat default.
 * A model's wire id reads as the list's alias.
 */
function claudeOwnSelection(
  own: ChatConfig | null | undefined,
  saved: ChatConfig | null | undefined,
  models: HarnessModel[],
  defaults: Selection,
) {
  const listed = (id: string | null | undefined) => (id ? claudeModelFor(id, models) : null);
  const savedModel = ownSetting(saved, 'model', undefined);
  const model = savedModel === undefined ? defaults.model : listed(savedModel);
  return {
    model: chatModelChoice(saved, own?.model ? listed(own.model) : null, model),
    effort: own?.effort ?? ownSetting(saved, 'effort', defaults.effort),
  };
}

/** The model main runs a Claude chat on whatever it picked itself (a MoMo chat's brain, chat meta momoModel, #2304), or null. */
const pinnedModel = (h: HarnessId, threadId: string | null | undefined, s: AppState, pending: unknown) =>
  ownsSelection(h, threadId, pending) ? (s.momoModels?.[threadId!] ?? null) : null;

export function setSelection(h: HarnessId, patch: Partial<Selection>, threadId?: string | null) {
  const pending = heldSwitch(threadId);
  // an effort pick replaces a level the switch was recorded with (set_session_harness); main merges it into its current choice
  if (threadId && pending?.harness === h && ('model' in patch || ('effort' in patch && pending.effort))) {
    const model = 'model' in patch ? configuredSwitchModel(h, patch.model) : pending.model;
    void native.session.pendingModel(threadId, h, model, patch.effort ?? null).then((applied) => {
      if (!applied) toast('The pending switch changed. Pick the model again.', 'error');
    }, toastFailure("Couldn't change the pending model"));
  }
  if (h === 'claude') {
    const s = getState();
    const pin = pinnedModel(h, threadId, s, heldSwitch(threadId));
    const effortModel = pin && patch.model ? patch.model : pin;
    // a MoMo chat's model is its brain's: main changes it (the brain chip follows), and the new-chat default stays
    if (pin && 'model' in patch) {
      const { model, ...rest } = patch;
      const label = harnessModels(h, s).find((m) => m.id === model)?.label ?? null;
      // MoMo always runs on a model its brain names: there is no default to go back to
      if (!model) toast('Pick a model for MoMo.', 'error');
      else
        void native.momoChat
          .setChatModel(threadId!, model, label)
          .then((r) => r.warning && toast(r.warning, 'error'), toastFailure("Couldn't change MoMo's model"));
      if (!Object.keys(rest).length) return;
      patch = rest;
    }
    const own = ownsSelection(h, threadId, heldSwitch(threadId))
      ? knownClaudeSettings(s.runtime[threadId!]?.settings, s.chatConfig[threadId!])
      : null;
    // the chat's selection becomes the default; a chat on the model's own default leaves the default's model and effort
    const defaults = s.prefs.claudeSelection;
    const mine = own ? claudeOwnSelection(own, s.chatConfig[threadId!], harnessModels(h, s), defaults) : null;
    const current = { ...defaults, ...(mine ? { model: mine.model, effort: mine.effort ?? defaults.effort } : {}) };
    if (ownsSelection(h, threadId, heldSwitch(threadId)) && ('model' in patch || 'effort' in patch)) {
      const { fast, ...settings } = patch;
      const ownSettings = effortModel && 'effort' in patch ? { ...settings, model: effortModel } : settings;
      patchRuntime(threadId!, (r) => ({ settings: { ...r.settings, ...ownSettings } }));
      setChatConfig(threadId!, ownSettings);
    }
    setPrefs({ claudeSelection: { ...current, ...patch } });
    return;
  }
  const p: Pick<ChatConfig, 'model' | 'effort' | 'serviceTier'> = {};
  if ('model' in patch) p.model = patch.model;
  if ('effort' in patch) p.effort = patch.effort;
  if ('fast' in patch) p.serviceTier = patch.fast ? 'priority' : 'default';
  if ('tier' in patch) p.serviceTier = patch.tier ?? 'default';
  // Every change also becomes the new-chat default. Copy the chat's full selection
  // so changing only effort or speed keeps its model as the default too.
  if (codexOwnsSelection(h, threadId, heldSwitch(threadId))) {
    const s = getState();
    const selection = { ...codexChatSelection(s.prefs, s.chatConfig[threadId!]), ...p };
    setChatConfig(threadId!, selection);
    setPrefs(selection);
    return;
  }
  setPrefs(p);
}

/** The family the composer targets: a pending switch's harness, the chat's own, or the new-chat default (a basic harness included). */
export const composerFamily = (threadId: string | null, s: AppState = getState()): HarnessFamily =>
  familyWith(threadId, sessionOf(threadId).pendingSwitch?.harness, s);

/** The composer's family with the chat's pending switch (its harness kind) as read by the caller. */
const familyWith = (threadId: string | null, pending: string | undefined, s: AppState): HarnessFamily =>
  threadId ? pendingFamily(pending, currentFamily(s.segments[threadId], threadId)) : newChatFamily(s);

/**
 * composerFamily for a component: the pending switch comes from the session as committed, which re-renders it and which
 * its other session reads see, never from patches sessionOf holds for the next frame (src/store/session/useSession.ts). A
 * selector that read sessionOf could see a switch the rest of the render does not (#2847).
 */
export function useComposerFamily(threadId: string | null): HarnessFamily {
  const pending = useSessionField(threadId, (x) => x.pendingSwitch?.harness);
  return useStore((s) => familyWith(threadId, pending, s));
}

/** composerFirstTier for a component, from the same session as useComposerFamily. */
export const useComposerFirstTier = (threadId: string | null): HarnessId | null => firstTierOf(useComposerFamily(threadId));

const pendingFamily = (kind: string | undefined, current: HarnessFamily): HarnessFamily =>
  kind?.startsWith('acp:') ? 'acp' : ((kind as HarnessId | undefined) ?? current);

/** The first-tier harness the composer targets, or null on a basic harness: it has no Codex or Claude account, selection or caps. */
export const composerFirstTier = (threadId: string | null, s: AppState = getState()): HarnessId | null =>
  firstTierOf(composerFamily(threadId, s));

/** True when the chat (or the new-chat default) runs on Claude Code. */
export const isClaudeComposer = (threadId: string | null): boolean => composerFamily(threadId) === 'claude';

export function useHarnessStatus(h: HarnessId): HarnessStatus {
  const conn = useStore((s) => s.conn);
  const connError = useStore((s) => s.connError);
  const requiresAuth = useStore((s) => s.requiresAuth);
  const account = useStore((s) => s.account);
  const rateLimits = useStore((s) => s.rateLimits);
  const accounts = useStore((s) => s.accounts);
  const codexBin = useStore((s) => s.codexBin);
  const codexBinInUse = useStore((s) => s.codexBinInUse);
  const userAgent = useStore((s) => s.userAgent);
  const codexCompat = useStore((s) => s.codexCompat);
  const codexQuit = useStore((s) => s.codexQuit);
  const claude = useStore((s) => s.claude.status);
  return useMemo(
    () =>
      h === 'codex'
        ? codexStatus({
            conn,
            connError,
            requiresAuth,
            account,
            rateLimits,
            accounts,
            codexBin,
            codexBinInUse,
            userAgent,
            codexCompat,
            codexQuit,
          } as AppState)
        : claude,
    [h, conn, connError, requiresAuth, account, rateLimits, accounts, codexBin, codexBinInUse, userAgent, codexCompat, codexQuit, claude],
  );
}

export const harnessAccounts = (h: HarnessId, s: AppState = getState()): HarnessAccounts =>
  h === 'codex'
    ? codexAccounts({ ...s, balanceMicros: getMoPilot().balanceMicros })
    : claudeAccounts(s.claude.status, s.claudeAccounts, s.claudeUsage, claudeKeyForAll(getClaudeKey()));

export function useHarnessAccounts(h: HarnessId): HarnessAccounts {
  const pool = useStore((s) => s.accounts);
  const account = useStore((s) => s.account);
  const rateLimits = useStore((s) => s.rateLimits);
  const requiresAuth = useStore((s) => s.requiresAuth);
  const claude = useStore((s) => s.claude.status);
  const claudePool = useStore((s) => s.claudeAccounts);
  const claudeUsage = useStore((s) => s.claudeUsage);
  const claudeKey = useClaudeKey();
  const balanceMicros = useMoPilot().balanceMicros;
  return useMemo(
    () =>
      h === 'codex'
        ? codexAccounts({ accounts: pool, account, rateLimits, requiresAuth, balanceMicros })
        : claudeAccounts(claude, claudePool, claudeUsage, claudeKeyForAll(claudeKey)),
    [h, pool, account, rateLimits, requiresAuth, balanceMicros, claude, claudePool, claudeUsage, claudeKey],
  );
}

/** Make an account the one its harness uses for new chats, or sign it in again when its login lapsed. */
export function chooseAccount(a: Account) {
  if (a.harness === 'claude') {
    if (a.status !== 'ok') return reloginClaudeAccount(a.id);
    if (a.id !== getState().claudeAccounts.active) return switchClaudeAccount(a.id);
    return;
  }
  if (a.status !== 'ok') return getState().accounts.accounts.length ? addAccount(a.id) : login();
  if (a.id !== getState().accounts.active) return switchAccount(a.id);
}

/** Sign a login in again to confirm which account it is (Claude Code's own CLI login, renamed by another client). */
export function verifyAccount(a: Account) {
  if (a.harness === 'claude') return reloginClaudeAccount(a.id);
}

/** Add an account to a harness. */
export function addHarnessAccount(h: HarnessId) {
  return h === 'claude' ? addClaudeAccount() : addAccount();
}

/** Forget an account (Codex: removes it; Claude: signs it out). */
export function removeHarnessAccount(a: Account) {
  return a.harness === 'claude' ? removeClaudeAccount(a.id) : removeAccount(a.id);
}

/**
 * Where /logout and the Log Out menu item go: Accounts & billing, on the row of the account this chat runs on. A basic
 * harness signs in on its own, so its chat goes to its row under Other harnesses.
 */
export function logoutRoute(threadId: string | null, s: AppState = getState()): { name: 'settings'; section: string; tab?: string } {
  const h = composerFirstTier(threadId, s);
  if (!h) return { name: 'settings', section: 'other-harnesses' };
  const id = chatAccount(h, threadId, s)?.serving ?? harnessAccounts(h, s).active?.id;
  return { name: 'settings', section: 'accounts', ...(id ? { tab: accountRowTab(h, id) } : {}) };
}

/** Put a chat on one account (null: back to automatic). */
export function setChatAccount(h: HarnessId, chatId: string, id: string | null) {
  return h === 'claude' ? pinClaudeChat(chatId, id) : pinCodexChat(chatId, id);
}

/** Per-chat accounts work for Claude always; for Codex only through the account relay. */
/** ChatGPT logins in the Codex pool. API keys and MoPilot credits never count as another account (D-70). */
export const codexSubscriptions = (accounts: AppState['accounts']['accounts']) =>
  accounts.filter((a) => (a.kind ?? 'chatgpt') === 'chatgpt');
export const canPinChats = (h: HarnessId, s: AppState = getState()) =>
  h === 'claude' || (s.accounts.relay && codexSubscriptions(s.accounts.accounts).length > 1);

export function useHarnessModels(h: HarnessId): HarnessModel[] {
  const models = useStore((s) => s.models);
  const claude = useStore((s) => s.claude.models);
  // on MoPilot credits Claude Code lists only what the gateway serves on the Anthropic wire (its capability table)
  const table = useMoPilot().modelCaps;
  const credits = useClaudeKey()?.mode === 'mopilot';
  return useMemo(
    () => (h === 'codex' ? codexModels({ models } as AppState) : credits ? claude.filter((m) => claudeModelServed(table, m.id)) : claude),
    [h, models, claude, table, credits],
  );
}

/** Model, effort and fast that will actually be used, after defaults. */
export function useEffectiveSelection(h: HarnessId, threadId: string | null) {
  const prefs = useStore((s) => s.prefs);
  const config = useStore((s) => s.config);
  const threadSettings = useStore((s) => (threadId ? s.runtime[threadId]?.settings : null));
  const chatConfig = useStore((s) => (threadId ? s.chatConfig[threadId] : null));
  // the pending switch the render's other session reads see, which re-renders it when it changes
  const pending = useSessionField(threadId, (x) => x.pendingSwitch);
  const pinned = useStore((s) => pinnedModel(h, threadId, s, pending));
  const models = useHarnessModels(h);
  const codexSel = codexChatSelection(prefs, codexOwnsSelection(h, threadId, pending) ? chatConfig : null);
  // setSelection writes a Claude chat's model/effort to its own settings, so read them back from there
  // too (whatever the model is): reading the global default instead made the effort slider snap back.
  const own = ownsSelection(h, threadId, pending) ? knownClaudeSettings(threadSettings, chatConfig) : null;
  const sel =
    h === 'claude'
      ? {
          ...prefs.claudeSelection,
          ...(own ? claudeOwnSelection(own, chatConfig, models, prefs.claudeSelection) : {}),
          // the model its turns run on: its brain's (main runs it above the chat's own pick)
          ...(pinned
            ? {
                model: claudeModelFor(pinned, models),
                effort: (own?.model === pinned ? own.effort : null) ?? ownSetting(chatConfig, 'effort', prefs.claudeSelection.effort),
              }
            : {}),
        }
      : { model: codexSel.model, effort: codexSel.effort, fast: codexSel.serviceTier === 'priority' };
  const nativeDefault = pending?.harness === h && pending.model === null;
  const selected = nativeDefault ? null : sel.model;
  const selectionModel = pending?.harness === h ? (nativeDefault ? null : configuredSwitchModel(h, pending.model, prefs)) : selected;
  const modelId =
    h === 'codex'
      ? effectiveModel(selectionModel, models.find((m) => m.isDefault)?.id, config?.model)
      : (selectionModel ?? models.find((m) => m.isDefault)?.id ?? models[0]?.id ?? null);
  // A variant the CLI didn't list (e.g. `opus[1m]`) takes its base model's effort levels and fast support.
  const model =
    models.find((m) => m.id === modelId) ??
    (h === 'claude' && modelId ? (models.find((m) => m.id === modelId.replace(/\[.*\]$/, '')) ?? null) : null);
  const visible = prefs.visibleEfforts;
  const efforts = (model?.efforts ?? []).filter((e) => h !== 'codex' || !visible || visible.includes(e));
  const effort =
    h === 'codex'
      ? (localEffortChoice('codex', sel.effort, threadSettings?.effort, config?.model_reasoning_effort) ?? model?.defaultEffort ?? null)
      : sel.effort && efforts.includes(sel.effort)
        ? sel.effort
        : (model?.defaultEffort ?? null);
  // whether Fast can be used comes from main: harness, provider, model and account layers (electron/session/caps.cjs)
  const speed = useChatCaps(threadId && chatFamily(threadId) === h ? threadId : null, { kind: h, model: modelId ?? undefined });
  const speedCap = speed.caps.speed;
  /** why the ⚡ toggle is unavailable, or null when it can be used */
  const fastUnavailable =
    speed.loaded && speedCap.state !== 'native'
      ? whyText(speedCap.why ?? { layer: 'harness', code: 'harness.undeclared' }, {
          label: HARNESS_LABEL[h],
          provider: speed.provider?.label,
          semantic: 'speed',
          account: harnessInfo(h)?.subscription,
        })
      : null;
  // Fast the account or harness can never have is left out, not greyed: nothing in the picker turns it on. A model,
  // provider, version, flag or session reason stays as a greyed toggle saying what would.
  const fastHidden = !!fastUnavailable && !!speedCap.why && FAST_INELIGIBLE.has(speedCap.why.layer);
  // Codex: the stored tier counts only if this model offers it; Standard otherwise
  const tiers = h === 'codex' ? (model?.tiers ?? []) : [];
  const tier = h === 'codex' ? activeTier(tiers, codexSel.serviceTier ?? config?.service_tier) : null;
  const fast = h === 'codex' ? !!tier && !fastUnavailable : !!sel.fast && !fastUnavailable;
  return { modelId, model, automatic: selectionModel == null, models, efforts, effort, fast, tiers, tier, fastUnavailable, fastHidden };
}

/** Why-layers that mean this account or harness is not eligible for Fast at all. */
const FAST_INELIGIBLE: ReadonlySet<string> = new Set(['account', 'harness']);
