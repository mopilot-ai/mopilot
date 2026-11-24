import { dictationStub } from './composer-speech-stub.ts';
import { composerSpeechMock } from './speechMock.ts';
import './composer-child-stubs.ts';
// Boundaries of the Composer (src/components/composer/Composer.tsx) for its tests: the store, the session, the
// harness registry and IPC are fakes recorded in `events`; child components that are tested on their own
// are small stand-ins. Import after './dom.ts' and before importing Composer.
import { dispatchComposerText } from '../../src/lib/composerEvents.ts';
import { withQueued } from '../../src/lib/queued.ts';
import { mock } from 'node:test';
import { createElement as h, act, useSyncExternalStore } from 'react';
import { $, fakeStore, mockTsx, mount } from './composer-kit.ts';
import { insertHTML } from './composer-dom.ts';
import { EMPTY_SESSION } from '../../src/store/session/sessionState.ts';
import { firstTierOf } from '../../src/harness/family.ts';
import { installNativeStub } from './ports/native.ts';
import { stubStore } from './stubs.ts';

export const events: any[][] = [];
export const rec =
  (name: string, ret?: any) =>
  (...a: any[]) => (events.push([name, ...a]), ret);
export const last = (name: string) => events.filter((e) => e[0] === name).at(-1);
export const all = (name: string) => events.filter((e) => e[0] === name);
export const store = fakeStore<any>({});
export let fx: any = {};
export const sessionOf = (id: string | null) => (id && store.get().sessions[id]) || EMPTY_SESSION;
export const setSessionState = (id: string, patch: any) =>
  store.set((s: any) => ({ sessions: { ...s.sessions, [id]: { ...sessionOf(id), ...patch } } }));
const harnessOf = (id: string | null) =>
  sessionOf(id).pendingSwitch?.harness ?? (id ? (store.get().harnessOf[id] ?? 'codex') : store.get().newHarness);
const composerFamily = (id: string | null) => {
  const kind = sessionOf(id).pendingSwitch?.harness;
  return kind?.startsWith('acp:') ? 'acp' : (kind ?? ((id ? store.get().basicOf[id] : store.get().newBasic) ? 'acp' : harnessOf(id)));
};

// voice state, read with a selector like zustand's hook
let voice: any = { phase: 'idle', threadId: null, muted: false, caption: null, level: 0, error: null };
const voiceListeners = new Set<() => void>();
export const setVoice = (patch: any) =>
  act(async () => {
    voice = { ...voice, ...patch };
    voiceListeners.forEach((l) => l());
  });
const useVoice = (sel: (v: any) => any = (v) => v) =>
  useSyncExternalStore(
    (cb) => (voiceListeners.add(cb), () => voiceListeners.delete(cb)),
    () => sel(voice),
  );

// happy-dom has no canvas: a 2D context that records what was drawn
export const drawn: any[] = [];
const W = window as any;
W.HTMLCanvasElement.prototype.getContext = function () {
  const ctx: any = { calls: drawn };
  for (const m of ['fillRect', 'beginPath', 'moveTo', 'lineTo', 'stroke'])
    ctx[m] = (...a: any[]) => drawn.push([m, ...a, { strokeStyle: ctx.strokeStyle, lineWidth: ctx.lineWidth, fillStyle: ctx.fillStyle }]);
  return ctx;
};
W.HTMLCanvasElement.prototype.toDataURL = () => 'data:image/png;base64,SKETCH';
(globalThis as any).FileReader = W.FileReader;

export { dragEvent, insertHTML } from './composer-dom.ts';

export function reset() {
  (document as any).execCommand = insertHTML;
  drawn.length = 0;
  events.length = 0;
  voice = { phase: 'idle', threadId: null, muted: false, caption: null, level: 0, error: null };
  store.reset({
    shellFit: { sidebar: true, summary: true },
    shellForced: {},
    drafts: {},
    runtime: {},
    chatConfig: {},
    prefs: { permission: 'default', sendWith: 'enter', followUp: 'queue' },
    segments: {},
    threads: {},
    sessions: {},
    harnessOf: {},
    basicOf: {},
    basicHarnesses: [],
    newHarness: 'codex',
    newBasic: null,
    newChatProjectId: null,
    savedProjects: [],
    newChatWorktree: null,
    newChatCloudEnv: null,
    newChatCwd: null,
    conn: 'ready',
    route: { name: 'home' },
    newChatTemporary: false,
    handoffCarry: {},
    threadOrder: [],
    claudeArchived: {},
  });
  fx = {
    location: { machine: null, pending: false },
    // what the machine's agent lists for the / menu (session/useMachineCommands.ts): null for a chat on this Mac
    machineCommands: null,
    attachmentTarget: { why: null, read: () => ({ key: 'local', blocked: false }) },
    blocked: {},
    project: null,
    sel: {
      model: { id: 'm1', label: 'M1', efforts: ['low', 'high'], autoMode: true },
      models: [
        { id: 'm1', label: 'M1', efforts: ['low', 'high'], defaultEffort: 'high' },
        { id: 'm2', label: 'M2', efforts: ['low'], defaultEffort: 'low', description: 'Second' },
      ],
      efforts: ['low', 'high'],
      effort: 'high',
      fast: false,
      tiers: [],
      tier: null,
      fastUnavailable: null,
      fastHidden: false,
    },
    nativeCmds: null,
    skillFiles: null,
    provider: null,
    registry: () => ({ menu: [], hidden: [] }),
    resolve: () => ({ kind: 'none' }),
    appEntries: () => [],
    caps: {},
    /** the harness kind each capability read was hinted with */
    capHints: [],
    chatCaps: { goal: { state: 'native', via: 'rpc' } },
    goalOff: null,
    acpRegistry: { menu: [] },
    acpTyped: () => ({ kind: 'text' }),
    fastNote: null,
    /** the harness each Fast billing note was read for */
    fastNoteFor: [],
    mcpRows: [],
    plugins: async () => ({ marketplaces: [] }),
    pluginSkills: async () => [],
    pluginsChanged: null,
    skills: async () => ({ skills: [] }),
    refs: async () => [],
    shell: async () => ({ output: 'ok' }),
    codexFix: null,
    exists: {},
    texts: {},
    paths: {},
    saved: 'saved.png',
    cloudExec: async () => ({ ok: true, id: 'task-1', output: '' }),
    envs: async () => ({ envs: [{ id: 'e1', label: 'Env one' }] }),
    gitBase: { ok: true, stdout: 'origin/main\n' },
    branches: {},
    openFiles: async () => ['/tmp/a.png', '/tmp/b.txt'],
    sendFails: null,
    reviewFails: false,
  };
}
reset();

stubStore({
  // a chat link's ⌥-click (session/openChat.ts)
  openInSplit: () => {},
  nativeOf: (id: string) => (store.get().basicOf?.[id] ? `acp:${store.get().basicOf[id]}:${id}` : id),
  giveBackToComposer: (id: string, text: string, attachments: any[] = [], prepend = false) => {
    if (dispatchComposerText(window, id, text, attachments, prepend)) return;
    const d = store.get().drafts[id];
    store.set((s: any) => ({
      drafts: {
        ...s.drafts,
        [id]: {
          ...d,
          ...(prepend
            ? withQueued(d?.text ?? '', d?.attachments ?? [], { text, attachments })
            : { text: (d?.text ? d.text + '\n' : '') + text, attachments: [...(d?.attachments ?? []), ...attachments] }),
        },
      },
    }));
  },
  removeQueued: (...args: any[]) => fx.removeQueued(...args),
  sendQueuedNow: async () => ({ status: 'sent' }),
  editBlockedFor: () => null,
  useStore: store.useStore,
  getState: store.get,
  setState: (p: any) => (events.push(['setState', typeof p === 'function' ? 'fn' : p]), store.set(p)),
  sendMessage: async (...a: any[]) => {
    events.push(['send', ...a]);
    if (fx.sendFails) throw fx.sendFails;
    if (fx.sendAnswer) return fx.sendAnswer(...a);
  },
  createChatThread: rec('createChat'),
  interrupt: async (...a: any[]) => {
    events.push(['interrupt', ...a]);
    if (fx.stopFails) throw fx.stopFails;
  },
  setDraft: (key: string, d: any) => (events.push(['draft', key, d]), store.set((s: any) => ({ drafts: { ...s.drafts, [key]: d } }))),
  setPrefs: (p: any) => (events.push(['prefs', p]), store.set((s: any) => ({ prefs: { ...s.prefs, ...p } }))),
  setChatConfig: (id: string, patch: any) =>
    store.set((s: any) => ({ chatConfig: { ...s.chatConfig, [id]: { ...s.chatConfig[id], ...patch } } })),
  // the saved default: as set, else what the fixture says new chats start on
  savedDefaultHarness: (s = store.get()) => s.prefs?.defaultHarness ?? (s.newBasic ? `acp:${s.newBasic}` : s.newHarness),
  // what new chats start on now: the fixture's newBasic / newHarness
  defaultHarness: (s = store.get()) => ({ kind: s.newBasic ? `acp:${s.newBasic}` : s.newHarness }),
  setDefaultHarness: (kind: string) => (
    events.push(['prefs', { defaultHarness: kind }]), store.set((s: any) => ({ prefs: { ...s.prefs, defaultHarness: kind } }))
  ),
  navigate: rec('navigate'),
  loadCloudTasks: rec('loadCloudTasks'),
  compactThread: (...args: any[]) => (events.push(['compact', ...args]), fx.compactAnswer?.(...args)),
  blockedReason: (_id: any, s: string) => fx.blocked[s] ?? null,
  forkThread: rec('fork'),
  startReview: (...a: any[]) => (events.push(['review', ...a]), fx.reviewFails ? Promise.reject(fx.reviewFails) : Promise.resolve()),
  toast: rec('toast'),
  toastFailure: (what: string) => (e: any) => rec('toast')(`${what}: ${e?.message ?? e}`, 'error'),
  currentCwdForNewChat: () => '/home',
  newChatProject: () => null,
  newChatTarget: () => fx.project,
  newChatFolderKey: () => fx.project?.path || null,
  // no folder on another machine picked: a new chat runs on this Mac
  newChatHostPick: (s = store.get()) => s.newChatHost ?? null,
  dropGoneHostPick: () => undefined,
  openChanges: rec('openChanges'),
  toggleTasksPane: rec('toggleTasksPane'),
  selectionAttachment: (text: string) => ({ kind: 'selection', path: '', name: 'Selection', text }),
  renameThread: async (...a: any[]) => void events.push(['rename', ...a]),
  chatBasicHarness: (id: string, s = store.get()) => s.basicOf[id] ?? null,
  newChatBasic: (s: any) => s.newBasic,
  threadTitle: (t: any) => t.title,
  newChatHarness: (s = store.get()) => s.newHarness,
  newChatKind: (s = store.get()) => (s.newBasic ? `acp:${s.newBasic}` : s.newHarness),
  stopAllTasks: rec('stopAllTasks'),
  setUltracode: rec('ultracode'),
  newChatWorktreeOn: (s = store.get()) => s.newChatWorktree ?? s.prefs.worktreeDefault === true,
  setNewChatWorktree: (on: boolean) => (
    events.push(['worktree', on]), store.set((s: any) => ({ newChatWorktree: null, prefs: { ...s.prefs, worktreeDefault: on } }))
  ),
  searchThreads: async () => ({}),
});
mock.module('../../src/store/session/useSession.ts', {
  namedExports: {
    useSession: (id: string | null) => store.useStore(() => sessionOf(id)),
    useSessionField: (id: any, pick: any) => pick((((id: string | null) => store.useStore(() => sessionOf(id))) as (id: any) => any)(id)),
    sessionOf,
    setSession: async (id: string, patch: any) => (events.push(['session', id, patch]), setSessionState(id, patch)),
  },
});
mock.module('../../src/session/harness/select.ts', {
  namedExports: {
    // a basic harness's chat (or a new chat on one) is ACP; otherwise the first-tier harness
    composerFamily,
    composerFirstTier: (id: string | null) => firstTierOf(composerFamily(id)),
    useComposerFamily: composerFamily,
    useComposerFirstTier: (id: string | null) => firstTierOf(composerFamily(id)),
    isClaudeComposer: (id: string | null) => harnessOf(id) === 'claude',
    logoutRoute: (id: string | null) => ({ name: 'settings', section: 'accounts', chat: id }),
    selectionFor: () => null,
    setSelection: (...args: any[]) => {
      if (fx.selectionFails) throw fx.selectionFails;
      return rec('selection')(...args);
    },
    useEffectiveSelection: () => fx.sel,
    useHarnessAccounts: () => ({ active: null, accounts: [] }),
  },
});
mock.module('../../src/session/harness/claude.ts', {
  namedExports: {
    useClaudeCommands: () => fx.nativeCmds,
    useClaudeSkillFiles: () => fx.skillFiles,
    useCommandProvider: () => fx.provider,
    setRemoteControl: rec('remoteControl'),
  },
});
mock.module('../../src/harness/commands.ts', {
  namedExports: {
    composeCommands: (p: any, caps?: any) => fx.registry(p, caps),
    resolveTyped: (v: string, reg: any) => fx.resolve(v, reg),
    appEntries: (...a: any[]) => fx.appEntries(...a),
    slashNames: (c: { id: string; title: string; aliases?: string[] }) =>
      [c.id, c.title.replace(/^\//, '').replace(/ \(.*$/, ''), ...(c.aliases ?? [])].map((n) => n.toLowerCase()),
  },
});
mock.module('../../src/store/session/useCaps.ts', {
  namedExports: {
    useCap: (_id: any, sem: string, hint?: { kind?: string }) => (fx.capHints.push(hint?.kind), { state: fx.caps[sem] ?? 'none' }),
    // the voice conversation button and the + menu's audio message read the chat's own capabilities
    useCaps: (_id: any, hint?: { kind?: string }) => (fx.capHints.push(hint?.kind), { ...speechCaps(), ...fx.chatCaps }),
  },
});
mock.module('../../src/session/harness/goalCommand.ts', { namedExports: { goalOff: () => fx.goalOff, runGoalCommand: rec('goal') } });
mock.module('../../src/session/harness/acp.ts', {
  namedExports: {
    acpRegistry: () => fx.acpRegistry,
    acpTyped: (v: string) => fx.acpTyped(v),
    basicLabel: (id: string) => id[0].toUpperCase() + id.slice(1),
    setAcpMode: (...a: any[]) => (rec('acpMode')(...a), !fx.acpRefuses),
    setAcpConfig: (...a: any[]) => (rec('acpConfig')(...a), !fx.acpRefuses),
  },
});
mock.module('../../src/harness/accounts.ts', {
  namedExports: {
    ...(await import('../../src/harness/accounts.ts')),
    fastBillingNote: (h: string) => (fx.fastNoteFor.push(h), fx.fastNote),
  },
});
mock.module('../../src/session/harness/mcpRows.ts', {
  namedExports: {
    loadMcpRows: async (...a: any[]) => {
      events.push(['mcpRows', ...a]);
      if (fx.mcpRows instanceof Error) throw fx.mcpRows;
      return fx.mcpRows;
    },
  },
});
mock.module('../../src/harness/codexCatalog.ts', {
  namedExports: {
    listCodexPlugins: () => fx.plugins(),
    listCodexSkills: (cwd: string, force: boolean) => (events.push(['skills', cwd, force]), fx.skills(force)),
    composerCodexSkills: (r: any) => r.skills,
  },
});
mock.module('../../src/session/chatReference.ts', { namedExports: { chatReferences: (v: string) => fx.refs(v) } });
mock.module('../../src/harness/polyfills/shell.ts', {
  namedExports: {
    parseBang: (t: string) => (t.startsWith('!') && t.length > 1 ? { cmd: t.slice(1) } : null),
    runShell: (_pty: any, cmd: string, cwd: string) => (events.push(['shell', cmd, cwd]), fx.shell(cmd, cwd)),
    shellAttachment: (r: any) => ({ name: 'Shell output', text: r.output }),
  },
});
const speechCaps = () => ({
  voiceChat: { state: fx.caps.voiceChat === 'none' ? 'absent' : 'native' },
  audioInput: { state: fx.audioSupported ? 'native' : 'absent' },
});
installNativeStub({
  // the composer's strips read `host.unattended` (off here)
  flags: { isEnabled: () => false, onChanged: () => () => {} },
  speech: composerSpeechMock(
    () => fx.caps.voiceChat !== 'none',
    () => !!fx.audioSupported,
    () => fx.audioHold?.() ?? Promise.resolve('audio-transfer'),
  ),
  // main's context snapshots (src/session/useContextSnapshot.ts): none known
  context: { get: async () => null, refresh: async () => null, onSnapshot: () => () => {} },
  fs: {
    exists: async (p: string) => {
      if (fx.existsAnswer) return fx.existsAnswer(p);
      if (fx.existsFails) throw fx.existsFails;
      return !!fx.exists[p];
    },
    readText: async (p: string) => (events.push(['readText', p]), fx.texts[p] ?? null),
    writeText: async (p: string, t: string) => void events.push(['writeText', p, t]),
    readImageDataUrl: async (p: string) => (fx.readImageDataUrl ? fx.readImageDataUrl(p) : p.includes('nopreview') ? null : `data:${p}`),
    pathForFile: (f: any) => fx.paths[f.name] ?? '',
    saveTempImage: async (d: string) => (events.push(['saveTemp', d.slice(0, 22)]), fx.saveTempImage ? fx.saveTempImage(d) : fx.saved),
  },
  cloud: { exec: (...a: any[]) => (events.push(['cloudExec', ...a]), fx.cloudExec()), envs: () => fx.envs() },
  dialog: { openFiles: () => fx.openFiles() },
  shell: { openExternal: rec('openExternal') },
  git: {
    run: async (...a: any[]) => (events.push(['git', ...a]), fx.gitBase),
    // a folder's branch list (null: not a repo), as the / menu reads it for a draft's Worktree entry
    branches: async (p: string) => fx.branches[p] ?? null,
  },
  pty: {},
  search: { files: async () => ({ files: fx.files ?? [] }) },
  session: { release: async (id: string) => void events.push(['release', id]) },
  plugins: {
    skillsFor: async (family: string) => (events.push(['pluginSkills', family]), fx.pluginSkills(family)),
    onChanged: (cb: () => void) => ((fx.pluginsChanged = cb), () => (fx.pluginsChanged = null)),
  },
});
// Computer History's share dialog has its own test (computerHistoryShareUI.test.ts): here it attaches what it is given
mock.module('../../src/components/composer/ComputerHistoryShare.tsx', {
  namedExports: {
    ComputerHistoryShare: (p: any) =>
      h('button', { className: 'stub-share', onClick: () => (p.onAttach(fx.shareAttachment), p.onClose()) }),
  },
});
mock.module('../../src/session/voice.ts', {
  namedExports: {
    useVoice,
    VOICE_UNAVAILABLE: 'Voice chat needs Codex.',
    startVoiceChat: (id: string | null, signal?: AbortSignal, opening?: () => void) => {
      rec('startVoice')(id);
      return fx.startVoiceChat?.(id, signal, opening);
    },
    stopVoice: async (...a: any[]) => {
      rec('stopVoice')(...a);
    },
    toggleMute: rec('toggleMute'),
    dismissVoiceError: rec('dismissVoice'),
  },
});
mock.module('../../src/components/markdown/SkillLink.tsx', {
  namedExports: { SkillLink: ({ children }: any) => children, openSkill: rec('openSkill') },
});
mock.module('../../src/session/open.ts', {
  namedExports: { openPath: rec('openPath'), openLink: rec('openLink'), openMessageLink: rec('openMessageLink') },
});
const C =
  (name: string, render: (p: any) => any = () => null) =>
  (p: any) =>
    render(p) ?? null;
const { QueuedList: ActualQueuedList } = await import('../../src/components/composer/QueuedList.tsx');
mockTsx(new URL('../../src/session/useComposerLocation.ts', import.meta.url), { useComposerLocation: () => fx.location });
mockTsx(new URL('../../src/session/useAttachmentTarget.ts', import.meta.url), { useAttachmentTarget: () => fx.attachmentTarget });
mockTsx(new URL('../../src/session/useMachineCommands.ts', import.meta.url), {
  useMachineCommands: (threadId: string | null, wanted: boolean | 'draft') =>
    typeof fx.machineCommands === 'function' ? fx.machineCommands(threadId, wanted) : fx.machineCommands,
});
mockTsx(new URL('../../src/components/composer/QueuedList.tsx', import.meta.url), {
  QueuedList: C('QueuedList', ({ threadId, onEdit }) =>
    fx.realQueuedList
      ? h(ActualQueuedList, { threadId, onEdit })
      : h('button', { className: 'stub-queued', onClick: () => onEdit(fx.queuedEdit) }, threadId),
  ),
});
mockTsx(new URL('../../src/components/composer/ProjectMenu.tsx', import.meta.url), {
  ProjectMenu: C('ProjectMenu', ({ open, onClose }) =>
    open ? h('button', { className: 'stub-project-menu', onClick: onClose }, 'projects') : null,
  ),
});
mockTsx(new URL('../../src/components/composer/BranchPicker.tsx', import.meta.url), {
  WorktreeChip: C('WorktreeChip', ({ path }) => h('span', { className: 'stub-worktree' }, path)),
});
mockTsx(new URL('../../src/components/composer/WorkspaceChip.tsx', import.meta.url), {
  WorkspaceChip: C('WorkspaceChip', ({ path }) => h('span', { className: 'stub-workspace' }, path)),
  pickedWorkspace: (s: any, root: string) => (s.newChatWorkspace?.root === root ? s.newChatWorkspace : null),
});
mockTsx(new URL('../../src/components/composer/WorktreeHint.tsx', import.meta.url), {
  WorktreeHint: C('WorktreeHint', ({ path }) => h('span', { className: 'stub-worktree-hint' }, path)),
});
mockTsx(new URL('../../src/components/harnessPicker/HarnessPicker.tsx', import.meta.url), {
  ModelPicker: C('ModelPicker', () => h('span', { className: 'stub-model' })),
});
mockTsx(new URL('../../src/components/composer/RoutingChip.tsx', import.meta.url), {
  RoutingChip: C('RoutingChip', () => h('span', { className: 'stub-routing' })),
});
mockTsx(new URL('../../src/components/composer/NextMessageChip.tsx', import.meta.url), {
  NextMessageChip: C('NextMessageChip', () => h('span', { className: 'stub-next' })),
});
mockTsx(new URL('../../src/components/harness/parts.tsx', import.meta.url), { PARTS: { codex: { fastDesc: 'Codex fast' }, claude: {} } });
mockTsx(new URL('../../src/components/harness/codex/Plugins.tsx', import.meta.url), {
  PluginLogo: C('PluginLogo', ({ p }) => h('i', { className: 'stub-logo' }, p.id)),
});
mockTsx(new URL('../../src/components/pages/Login.tsx', import.meta.url), { useCodexFix: () => fx.codexFix });
mockTsx(new URL('../../src/components/ui/Dictation.tsx', import.meta.url), {
  Dictation: C(
    'Dictation',
    dictationStub(() => fx.dictationStopped?.()),
  ),
});
mockTsx(new URL('../../src/components/thread/StatusStrip.tsx', import.meta.url), {
  StatusStrip: C('StatusStrip', ({ confirm, setConfirm }) =>
    h('button', { className: 'stub-strip', 'data-confirm': String(confirm), onClick: () => setConfirm(false) }, 'strip'),
  ),
});

const { Composer, permissionIcon } = await import('../../src/components/composer/Composer.tsx');
export { Composer, permissionIcon };

/** Render the composer; `type()` puts text in the editor with the caret at its end, as typing would. */
export async function mountComposer(
  props: { threadId: string | null; variant?: 'home' | 'thread'; inPane?: boolean } = { threadId: null },
) {
  const p = { variant: props.threadId ? 'thread' : 'home', ...props };
  const m = await mount(h(Composer, p as any));
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
  const editor = () => $('.composer-editor') as any;
  return {
    ...m,
    editor,
    rerender: (next: any = {}) => m.render(h(Composer, { ...p, ...next } as any)),
    async type(text: string, caretAt = text.length) {
      await act(async () => {
        const el = editor();
        el.textContent = text;
        const node = el.firstChild ?? el;
        const range = document.createRange();
        range.setStart(node, node === el ? 0 : caretAt);
        range.collapse(true);
        window.getSelection()!.removeAllRanges();
        window.getSelection()!.addRange(range);
        el.dispatchEvent(new (window as any).InputEvent('input', { bubbles: true }));
      });
    },
    async key(k: string, init: Record<string, any> = {}) {
      const ev = new (window as any).KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...init });
      await act(async () => void editor().dispatchEvent(ev));
      return ev.defaultPrevented as boolean;
    },
    get text() {
      return editor().value as string;
    },
  };
}

/** Let async handlers (sends, reads, timers up to `ms`) finish. */
export const settle = (ms = 0) =>
  act(async () => {
    for (let i = 0; i < 4; i++) await new Promise((r) => setTimeout(r, ms));
  });
