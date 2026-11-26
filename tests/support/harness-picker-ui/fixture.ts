// Shared DOM, harness/account/model mocks, and per-test picker state for harness picker UI unit cases.
import { test, mock, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import '../dom.ts';
import { $, $$, click, fakeStore, fire, flush, mockTsx, mount, mouse } from '../composer-kit.ts';
import { EMPTY_SESSION } from '../../../src/store/session/sessionState.ts';
import { defined } from '../defined.ts';
import { stubStore } from '../stubs.ts';

const events: any[][] = [];
const rec =
  (name: string, ret?: any) =>
  (...a: any[]) => (events.push([name, ...a]), ret);
const store = fakeStore<any>({});
let fx: any;
// Real draft journeys opt in; isolated UI cases may intentionally hold the displayed harness fixed.
const draftKind = (s = store.get()) => (fx?.followDraftPick && s.newChatHarnessPick) || (s.newBasic ? `acp:${s.newBasic}` : s.newHarness);
const sessionOf = (id: string | null) => (id && store.get().sessions[id]) || EMPTY_SESSION;
stubStore({
  useStore: store.useStore,
  getState: store.get,
  nativeOf: (id: string) => (store.get().basicOf[id] ? `acp:${store.get().basicOf[id]}:${id}` : id),
  chatKind: (id: string) => (store.get().basicOf[id] ? `acp:${store.get().basicOf[id]}` : (store.get().harnessOf[id] ?? 'codex')),
  setState: (p: any) => store.set(p),
  setPrefs: (p: any) => (events.push(['prefs', p]), store.set((s: any) => ({ prefs: { ...s.prefs, ...p } }))),
  // the saved default: as set, else what the fixture says new chats start on
  savedDefaultHarness: (s = store.get()) => s.prefs?.defaultHarness ?? (s.newBasic ? `acp:${s.newBasic}` : s.newHarness),
  // what new chats start on now: the fixture's newBasic / newHarness
  defaultHarness: (s = store.get()) => ({ kind: draftKind(s) }),
  savedDefaultResolved: (s = store.get()) => ({ kind: s.newBasic ? `acp:${s.newBasic}` : s.newHarness }),
  setDefaultHarness: (kind: string) => (
    events.push(['prefs', { defaultHarness: kind }]), store.set((s: any) => ({ prefs: { ...s.prefs, defaultHarness: kind } }))
  ),
  // a new chat's pick is this draft's: the saved default stays as it was
  pickNewChatHarness: (kind: string) => (events.push(['pick', kind]), store.set({ newChatHarnessPick: kind })),
  navigate: rec('navigate'),
  toast: rec('toast'),
  toastFailure: (what: string) => (e: any) => rec('toast')(`${what}: ${e?.message ?? e}`, 'error'),
  chatFamily: (id: string) => (store.get().basicOf[id] ? 'acp' : (store.get().harnessOf[id] ?? 'codex')),
  newChatHarness: (s = store.get()) => (draftKind(s).startsWith('acp:') ? s.newHarness : draftKind(s)),
  newChatBasic: (s: any) => (draftKind(s).startsWith('acp:') ? draftKind(s).slice(4) : null),
  // no folder on another machine is picked here (tests/modelPickerOnMachine.test.ts has one)
  newChatHostPick: () => null,
  chatBasicHarness: (id: string, s = store.get()) => s.basicOf[id] ?? null,
  ensureHarness: rec('ensure'),
  refreshHarnessModels: rec('refreshModels'),
  pauseGoal: (id: string) => (events.push(['pause', id]), fx.pauseFails ? Promise.reject(new Error('x')) : Promise.resolve()),
  removeQueued: (id: string, q: string) => (
    events.push(['unqueue', id, q]), q.startsWith('bad') ? Promise.reject(new Error(`no ${q}`)) : Promise.resolve(q !== 'sent')
  ),
  giveBackToComposer: rec('draft'),
});
mock.module('../../../src/store/session/useSession.ts', {
  namedExports: {
    flushSessionPatches: () => {},
    useSession: (id: string | null) => store.useStore(() => sessionOf(id)),
    useSessionField: (id: string | null, pick: any) => pick(store.useStore(() => sessionOf(id))),
    sessionOf,
    setSession: async (id: string, patch: any) => {
      events.push(['session', id, patch]);
      store.set((s: any) => ({ sessions: { ...s.sessions, [id]: { ...sessionOf(id), ...patch } } }));
    },
  },
});
mock.module('../../../src/store/session/useCaps.ts', {
  namedExports: { useChatCaps: (id: any, hint: any) => (events.push(['caps', id, hint]), { provider: fx.provider }) },
});
mock.module('../../../src/lib/flags.ts', { namedExports: { useEnabledHarnesses: () => fx.enabled } });
// the route's own wording and header rule are real; only main's answer is the fixture's (tests/harnessRouteUI.test.ts has the store)
// a query makes it a module of its own, which the mock below does not replace
const realRoutesUrl = '../../../src/harness/routes.ts?picker-real';
const realRoutes: typeof import('../../../src/harness/routes.ts') = await import(realRoutesUrl);
mock.module('../../../src/harness/routes.ts', {
  namedExports: { ...realRoutes, useHarnessRoute: (h: string) => fx?.routes?.[h] ?? null },
});
mock.module('../../../src/session/harness/switch.ts', {
  namedExports: {
    newChatWithSummary: (...a: any[]) => (
      events.push(['newChatWithSummary', ...a]), fx.newChatFails ? Promise.reject(new Error('app-server is down')) : Promise.resolve(null)
    ),
  },
});
mock.module('../../../src/session/harness/acp.ts', {
  namedExports: {
    BASIC_HOVER: (l: string) => `${l} is basic.`,
    basicLabel: (id: string) => id[0].toUpperCase() + id.slice(1),
    optionValues: (o: any) => o.options ?? [],
    acpModelName: (config: any) => {
      const model = config?.find((o: any) => o.category === 'model');
      return model
        ? ((model.options ?? []).find((v: any) => v.value === model.currentValue)?.name ?? String(model.currentValue ?? ''))
        : null;
    },
    setAcpConfig: (...a: any[]) => (rec('acpConfig')(...a), !fx.acpRefuses),
    setAcpMode: (...a: any[]) => (rec('acpMode')(...a), !fx.acpRefuses),
    useFreshBasics: rec('freshBasics'),
  },
});
const labels = await import('../../../src/harness/chatAccountLabel.ts');
/** The composer's first-tier harness: a pending switch's, else the chat's own (or the new-chat default); null on a basic one. */
const firstTier = (id: string | null) => {
  const kind = sessionOf(id).pendingSwitch?.harness ?? (id ? (store.get().harnessOf[id] ?? 'codex') : draftKind());
  return kind.startsWith('acp:') ? null : kind;
};
mock.module('../../../src/session/harness/select.ts', {
  namedExports: {
    // the real wording: every surface names a chat's account the same way
    chatAccountLabel: labels.chatAccountLabel,
    pinnedElsewhere: labels.pinnedElsewhere,
    switchAccountLabel: labels.switchAccountLabel,
    harnessModels: (h: string) => fx.models[h] ?? [],
    selectionFor: (h: string) => fx.selFor?.[h] ?? { model: null },
    setSelection: rec('selection'),
    // a composer's pick (session/harness/select.ts): recorded as the selection it writes
    composerSelect: rec('selection'),
    makeSelectionDefault: rec('makeDefault'),
    chooseAccount: (a: any) => events.push(['chooseAccount', a.id]),
    setChatAccount: (...a: any[]) => (fx.failAccountCalls ? Promise.reject(new Error('chat is locked')) : rec('chatAccount')(...a)),
    useHarnessAccounts: (h: string) => fx.accounts[h] ?? { active: null, accounts: [] },
    useChatAccount: (h: string, chatId: string | null) => fx.own[`${h}:${chatId}`] ?? null,
    canPinChats: (h: string) => fx.pin.includes(h),
    composerFirstTier: firstTier,
    useComposerFirstTier: (id: string | null) => store.useStore(() => firstTier(id)),
    useHarnessModels: (h: string) => fx.models[h] ?? [],
    useModelsLoading: (h: string) => !!fx.loading?.[h],
    useHarnessStatus: (h: string) => fx.status[h] ?? { state: 'ready' },
    useEffectiveSelection: () => fx.sel,
  },
});
mock.module('../../../src/harness/accounts.ts', {
  namedExports: {
    MOPILOT_PLAN: 'MoPilot credits',
    accountName: (a: any) => a.email,
    accountStatusText: (a: any) => ({ text: `status ${a.status}`, tone: 'warn' }),
    fastBillingNote: () => fx.fastNote,
  },
});
// the picker's account row is real here; its wording has its own test (tests/accountRowUI.test.ts)
mockTsx(new URL('../../../src/components/harnessPicker/SwitchSheet.tsx', import.meta.url), {
  SwitchSheet: ({ onConfirm, onCancel, target, model, account }: any) => [
    createElement(
      'button',
      { key: 1, id: 'ss-confirm', onClick: () => onConfirm(fx.choices), 'data-model': model.id },
      `switch to ${target}${account === undefined ? '' : ` on ${account ?? 'the one in use'}`}`,
    ),
    createElement('button', { key: 2, id: 'ss-cancel', onClick: onCancel }, 'cancel'),
  ],
  NewChatSheet: ({ onConfirm, onCancel, target }: any) => [
    createElement('button', { key: 1, id: 'bs-confirm', onClick: onConfirm }, `new chat on ${target.basic ?? target.family}`),
    createElement('button', { key: 2, id: 'bs-cancel', onClick: onCancel }, 'cancel'),
  ],
});
mockTsx(new URL('../../../src/components/harnessPicker/AcpSwitchSheet.tsx', import.meta.url), {
  AcpSwitchSheet: ({ onConfirm, onCancel, target }: any) => [
    createElement('button', { key: 1, id: 'bs-confirm', onClick: () => onConfirm(fx.choices) }, `switch to ${target}`),
    createElement('button', { key: 2, id: 'bs-cancel', onClick: onCancel }, 'cancel'),
  ],
});
const part = (h: string, field: 'accounts' | 'claudeAccounts', extra: any = {}) => ({
  useAutoSwitch: () => [
    store.useStore((s: any) => s[field]?.autoSwitch !== false),
    async (on: boolean) => {
      if (fx?.failAccountCalls) throw new Error('settings are locked');
      events.push(['autoSwitch', h, on]);
      store.set((s: any) => ({ [field]: { ...s[field], autoSwitch: on } }));
    },
  ],
  Icon: ({ size }: any) => createElement('i', { className: `icon-${h}`, 'data-size': size }),
  signIn: rec(`signIn:${h}`, 'started'),
  signInLabel: `Sign in to ${h}`,
  missingHint: `Install ${h}`,
  ...extra,
});
mockTsx(new URL('../../../src/components/harness/parts.tsx', import.meta.url), {
  PARTS: { codex: part('codex', 'accounts'), claude: part('claude', 'claudeAccounts', { fastTip: 'Claude fast tip' }) },
});

const { createElement } = await import('react');
const HP = await import('../../../src/components/harnessPicker/HarnessPicker.tsx');
const { ModelPicker, HarnessIcon, BasicHarnessIcon, BasicBadge, UsageMeters, signInHarness, SwitchChip, ThreadHarnessBadge } = HP;

const models = [
  { id: 'old', label: 'Old', efforts: ['low', 'high'], defaultEffort: 'high' },
  { id: 'new', label: 'New', efforts: ['high'], defaultEffort: 'high', description: 'The newest', fast: true },
];
const sub = (id: string, email: string, extra: any = {}) => ({
  id,
  email,
  kind: 'subscription',
  status: 'ok',
  usage: { windows: [], source: 'none', at: null },
  ...extra,
});

beforeEach(() => {
  events.length = 0;
  store.reset({
    prefs: { modelScopeHintSeen: true },
    runtime: {},
    pending: [],
    segments: {},
    basicHarnesses: [],
    accounts: { accounts: [] },
    claudeChats: {},
    handoffCarry: {},
    drafts: {},
    sessions: {},
    harnessOf: {},
    basicOf: {},
    newHarness: 'codex',
    newBasic: null,
  });
  fx = {
    enabled: ['codex', 'claude'],
    provider: null,
    routes: {},
    accounts: { codex: { active: sub('a1', 'one@x.test'), accounts: [sub('a1', 'one@x.test')] } },
    own: {},
    pin: [],
    models: { codex: models, claude: models },
    status: {},
    fastNote: null,
    sel: {
      modelId: 'old',
      model: models[0],
      efforts: ['low', 'high'],
      effort: 'high',
      fast: false,
      tiers: [],
      tier: null,
      fastUnavailable: null,
      fastHidden: false,
    },
    choices: { mode: 'auto', goal: null, multiAgent: false, queued: 'send', effort: 'high' },
    pauseFails: false,
  };
});
afterEach(() => {
  document.body.innerHTML = '';
});

const openPicker = () => click($('[aria-label="Select model"]'));
// a pick returns to the effort pane, so the picker may already be open
const openHarnesses = async () => {
  if (!$('.effort-pop')) await openPicker();
  await click($('[aria-label="Select harness and model"]'));
  await flush();
};
const row = (text: string) => $$('.hp-row').find((r) => r.textContent!.includes(text))!;
const item = (text: string) => $$('.menu-item').find((r) => r.textContent === text)!;
const last = (name: string) => events.filter((e) => e[0] === name).at(-1);

async function key(el: Element, k: string) {
  await fire(el, new (window as any).KeyboardEvent('keydown', { key: k, bubbles: true }));
}

export {
  test,
  assert,
  $,
  $$,
  click,
  fire,
  flush,
  mount,
  mouse,
  EMPTY_SESSION,
  events,
  store,
  createElement,
  HarnessIcon,
  BasicHarnessIcon,
  BasicBadge,
  UsageMeters,
  signInHarness,
  SwitchChip,
  ThreadHarnessBadge,
  last,
  ModelPicker,
  openHarnesses,
  row,
  item,
  fx,
  models,
  openPicker,
  key,
  defined,
  sub,
  sessionOf,
};
