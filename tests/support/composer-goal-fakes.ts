import { goalSpeech } from './composer-goal-modules.ts';
// Boundary fakes for the goal composer's UI tests; tests own the mutable state while production controls stay isolated.
import * as React from 'react';
import { createElement } from 'react';
import { CircleX, Target } from 'lucide-react';
import { TextareaEditor } from './textarea-editor.ts';
import { harnessKindFrom, pendingBasic } from '../../src/harness/family.ts';
import { effectivePermission } from '../../shared/effectivePermission.mjs';

export const cap = { state: 'native', via: 'rpc' };
export const f: any = {
  CircleX,
  Target,
  whyText: (why: any) => why.code,
  state: {},
  session: { queue: [] },
  cap,
  sent: [],
  notices: [],
  refs: [],
  blocked: null,
  useStore: Object.assign((select: any) => select(f.state), { getState: () => f.state }),
  getState: () => f.state,
  // the store slice's own name for the barrel's getState (a component importing core gets it as get)
  get: () => f.state,
  setDraft: (key: string, draft: any) => {
    f.state.drafts[key] = draft;
  },
  sendMessage: async (...args: any[]) => {
    f.sent.push(args);
  },
  toast: (...args: any[]) => f.notices.push(args),
  errorText: (e: any) => e?.message ?? String(e),
  blockedReason: () => f.blocked,
  composerFirstTier: () => (f.basic ? null : f.harness),
  useComposerHarness: () => ({
    harness: f.basic ? null : f.harness,
    basic: f.basic,
    hint: { kind: f.basic ? `acp:${f.basic}` : f.harness },
    acpCommands: null,
  }),
  useChatPermission: (id: string | null) => effectivePermission(id ? f.state.chatConfig?.[id] : null, f.state.prefs?.permission, f.session),
  composerFamily: () => (f.basic ? 'acp' : f.harness),
  useComposerFamily: () => (f.basic ? 'acp' : f.harness),
  useComposerFirstTier: () => (f.basic ? null : f.harness),
  pendingBasic,
  harnessKindFrom,
  // every chat here is this Mac's: the host chip's owner reader answers at once
  useChatOwner: () => ({ ownerId: 'local', known: true, refresh: () => undefined }),
  // so is its machine: none, nothing pending, no machines listed
  useChatMachine: () => ({ machine: null, pending: false }),
  useComposerLocation: () => ({ machine: null, pending: false }),
  useAttachmentTarget: () => ({ why: null, read: () => ({ key: 'local', blocked: false }) }),
  useFolderHere: (_id: string | null, cwd: string) => cwd,
  useHostMachines: () => ({ machines: [], resolved: false }),
  dropGoneHostPick: () => undefined,
  // no plugin skills: the basic tier's / menu is the harness's own commands here
  usePluginSlashItems: () => [],
  HARNESS_TRAITS: { codex: { skills: 'codexSkillList' }, claude: { skills: 'catalog' }, acp: { skills: 'commands' } },
  newChatHarness: () => f.harness,
  chatBasicHarness: () => f.basic,
  newChatBasic: () => f.basic,
  currentCwdForNewChat: () => '/project',
  useSession: () => f.session,
  useSessionField: (id: any, pick: any) => pick(((() => f.session) as (id: any) => any)(id)),
  sessionOf: () => f.session,
  useCap: (_id: any, semantic: string) => ({ state: semantic === 'shell' && f.shell ? 'sage' : 'absent', via: 'none' }),
  useCaps: () => ({ goal: f.cap }),
  useClaudeCommands: () => null,
  useClaudeSkillFiles: () => null,
  useCommandProvider: () => f.provider,
  useEffectiveSelection: () => ({ model: { id: 'test' }, models: [], efforts: [], tiers: [], effort: 'medium' }),
  useHarnessAccounts: () => ({ active: null }),
  useVoice: (select: any) => select({ phase: 'idle', threadId: null }),
  useComposerSpeech: goalSpeech,
  goalOff: () => f.off,
  permissionMenu: () => ({ rows: [{ id: 'default', label: 'Ask for approval' }], title: 'Permissions' }),
  fullAccessBannerText: () => null,
  HARNESS_LABEL: { codex: 'Codex', claude: 'Claude Code' },
  PARTS: { codex: { fastDesc: 'Fast' }, claude: { fastDesc: 'Fast' } },
  COPY: { speed: { fastDesc: 'Fast' } },
  native: { session: {}, fs: {}, shell: {}, search: { files: async () => ({ files: f.files ?? [] }) } },
  navigated: [] as any[],
  navigate: (to: any) => {
    f.navigated.push(to);
  },
  chatReferences: async () => {
    if (f.refError) throw Error('read failed');
    return f.refs;
  },
  acpRegistry: () => ({
    menu: [
      { name: 'goal', dispatch: 'passthrough' },
      { name: 'help', dispatch: 'passthrough' },
    ],
  }),
  acpTyped: () => f.acpResult ?? { kind: 'passthrough' },
  withChatReferences: (text: string) => text,
  appEntries: () => [{ name: 'custom', hint: true, description: 'Custom command' }],
  composeCommands: () => ({ hidden: [], menu: [] }),
  resolveTyped: () => ({ kind: 'unknown', note: 'Unknown command' }),
  listsCodexPlugins: () => false,
  // the @ menu: its "Browser tabs" section (src/components/composer/BrowserTabMentions.tsx) as a test sets it
  useBrowserTabMentions: (...a: any[]) => f.tabs?.(...a) ?? [],
  BrowserTabRows: (p: any) => f.tabRows?.(p) ?? null,
  tabToken: (t: any) => `<${t.key}>`,
  threadTitle: (t: any) => t.title,
  searchThreads: async () => ({}),
  composerCodexSkills: () => [],
  slashNames: (item: any) => [item.id.replace(/^acp:/, '')],
  Tooltip: ({ label, children }: any) => createElement('span', { title: label }, children),
  Popover: ({ open, children }: any) => (open ? createElement('div', null, children) : null),
  useAnchor: () => {
    const [open, setOpen] = React.useState(false);
    const ref = React.useRef(null);
    return { open, setOpen, ref, anchor: ref.current, close: () => setOpen(false), toggle: () => setOpen((v) => !v) };
  },
  ComposerInput: TextareaEditor,
};
