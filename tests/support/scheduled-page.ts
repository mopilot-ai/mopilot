// Isolated scheduled-page state, native boundaries and reusable interaction helpers.
// Scheduled: the task list, a task's detail and runs, and the "Schedule a task" dialog.
import { mock } from 'node:test';
import assert from 'node:assert/strict';
import './dom.ts';
import { fakeStore, popoverExports, render, click, byText, maybeText, type, flush } from './pages-kit.ts';
import { defaultHarnessExports } from './default-harness-fakes.ts';
import { installNativeStub } from './ports/native.ts';
import { stubStore } from './stubs.ts';

const fx = {
  usable: { codex: true, claude: true } as Record<string, boolean>,
  /** the harness each chat runs on now (chatKind) */
  chatKinds: {} as Record<string, string>,
  list: [] as any[],
  listGate: null as Promise<void> | null,
  runResult: 'run-1' as any,
  runs: {} as Record<string, any[]>,
  runsFail: false,
  saveFail: null as unknown,
  saveGate: null as Promise<void> | null,
  appsState: {
    scheduler: true,
    codexApp: { installed: true, running: true },
    claudeDesktop: { installed: true, running: false },
  } as any,
  confirmAnswer: false,
  deleteError: null as unknown,
  /** the user's machines as main lists them (useHostMachines); none: no Runs on field */
  machines: [] as any[],
};
const { createElement: h, Fragment, act } = await import('react');
const calls: any[] = [];
const store = fakeStore<any>({
  threads: {},
  prefs: {},
  models: [
    { model: 'gpt-5', displayName: 'GPT-5', supportedReasoningEfforts: [{ reasoningEffort: 'low' }, { reasoningEffort: 'high' }] },
    { model: 'gpt-4', displayName: 'GPT-4' },
  ],
  claude: { models: [{ id: 'opus', label: 'Opus', efforts: ['max'], isDefault: true, defaultEffort: 'max' }] },
  config: { model: 'gpt-5', model_reasoning_effort: 'high' },
  basicHarnesses: [
    { id: 'opencode', label: 'opencode', state: 'admitted' },
    { id: 'kimi', label: 'Kimi Code', state: 'signin' },
  ],
  savedProjects: [{ id: 'p-proj', name: 'proj', roots: [{ path: '/w/proj' }] }],
});
const sessions = fakeStore<any>({ sessions: {} });

const next: Record<string, Date | null> = {};

/** the ledger's records per task (native.automation.runs) */

/** what main says about the scheduler and the native apps (native.automation.apps) */

const changedListeners = new Set<() => void>();
/** main says a task changed */
const changed = () => act(async () => changedListeners.forEach((cb) => cb()));

(globalThis as any).confirm = (m: string) => (calls.push(['confirm', m]), fx.confirmAnswer);

stubStore({
  useStore: store.useStore,
  navigate: (r: any) => calls.push(['navigate', r]),
  toast: (...a: any[]) => calls.push(['toast', ...a]),
  setPrefs: (p: any) => (calls.push(['prefs', p]), store.setState({ prefs: { ...store.getState().prefs, ...p } })),
  currentCwdForNewChat: () => '/work/app',
  threadTitle: (t: any) => t.title ?? 'Untitled',
  harnessUsable: (h: string) => fx.usable[h],
  chatKind: (id: string) => fx.chatKinds[id] ?? 'codex',
  ...defaultHarnessExports(
    () => ({ ...store.getState(), usable: fx.usable }),
    (p: any) => store.setState({ prefs: { ...store.getState().prefs, ...p } }),
  ),
});
mock.module('../../src/store/session/useSession.ts', { namedExports: { flushSessionPatches: () => {}, useSessions: sessions.useStore } });
const mockSave = async (a: any) => {
  calls.push(['save', a]);
  if (fx.saveGate) await fx.saveGate;
  if (fx.saveFail) throw fx.saveFail;
  // main names a new task
  const saved = { ...a, id: a.id || `made-${a.name.toLowerCase().replace(/[^a-z]+/g, '-')}` };
  const i = fx.list.findIndex((x) => x.id === saved.id);
  fx.list = i < 0 ? [...fx.list, saved] : fx.list.map((x) => (x.id === saved.id ? saved : x));
  return saved;
};
mock.module('../../src/lib/automations.ts', {
  namedExports: {
    // the merge onto the task as it is now is tested in automationsLib.test.ts
    saveEditedAutomation: async (initial: any, edited: any) => (calls.push(['edited', initial.id]), mockSave(edited)),
    listAutomations: async () => {
      calls.push(['list']);
      if (fx.listGate) await fx.listGate;
      return fx.list;
    },
    saveAutomation: mockSave,
    deleteAutomation: async (id: string) => {
      calls.push(['delete', id]);
      if (fx.deleteError) throw fx.deleteError;
      fx.list = fx.list.filter((x) => x.id !== id);
    },
    describeRule: (r: string) => `rule(${r})`,
    nextRun: (r: string) => next[r] ?? null,
    // the real states are tested in automationsLib.test.ts; here a rule named R-end* has run out
    taskState: (a: any) =>
      a.status !== 'ACTIVE'
        ? { kind: 'paused' }
        : next[a.rrule]
          ? { kind: 'scheduled', next: next[a.rrule] }
          : { kind: String(a.rrule).startsWith('R-end') ? 'ended' : 'unscheduled' },
    TASK_STATE_LABEL: { paused: 'Paused', ended: 'Ended', unscheduled: 'No next run' },
    PRESETS: [
      { label: 'hourly', rule: 'FREQ=HOURLY;INTERVAL=1' },
      { label: 'daily', rule: 'FREQ=DAILY;BYHOUR=9;BYMINUTE=0' },
    ],
  },
});
mock.module('../../src/lib/format.ts', {
  namedExports: { modelLabel: (m: string) => `M:${m}`, effortLabel: (e: string) => `E:${e}`, relativeTime: (sec: number) => `t${sec}` },
});
mock.module('../../src/components/ui/Popover.tsx', { namedExports: popoverExports });
mock.module('../../src/lib/hostMachines.ts', { namedExports: { useHostMachines: () => ({ machines: fx.machines, resolved: true }) } });
// the machine's folder picker: "Use /srv/<name>" picks that folder there
mock.module('../../src/components/composer/HostFolderPicker.tsx', {
  namedExports: {
    HostFolderPicker: ({ hostId, onPick, onClose }: any) =>
      h('div', { 'data-testid': 'host-folder-picker' }, [
        h('button', { key: 'u', onClick: () => onPick(`/srv/${hostId}`) }, 'Use folder'),
        h('button', { key: 'c', onClick: onClose }, 'Close picker'),
      ]),
  },
});
installNativeStub({
  automation: {
    run: async (a: any) => {
      calls.push(['run', a.id]);
      if (fx.runResult instanceof Error || typeof fx.runResult !== 'string') throw fx.runResult;
      return fx.runResult;
    },
    runs: async (id: string) => {
      calls.push(['runs', id]);
      if (fx.runsFail) throw new Error('no ledger');
      return fx.runs[id] ?? [];
    },
    apps: async () => (calls.push(['apps']), fx.appsState),
    onChanged: (cb: () => void) => {
      changedListeners.add(cb);
      return () => changedListeners.delete(cb);
    },
  },
});
const { Scheduled, ScheduledNav } = await import('../../src/components/pages/Scheduled.tsx');

const task = (id: string, over: any = {}) => ({
  version: 1,
  id,
  kind: 'cron',
  name: `Task ${id}`,
  prompt: `prompt ${id}`,
  status: 'ACTIVE',
  rrule: `R-${id}`,
  cwds: ['/w/proj'],
  ...over,
});
const both = () => h(Fragment, null, h(ScheduledNav), h(Scheduled));
const navNames = (host: HTMLElement) => [...host.querySelectorAll('.sched-row .side-row-label')].map((e) => e.textContent);
const dialog = (host: HTMLElement) => host.querySelector('[role=dialog]') as HTMLElement | null;
/** Opens one of the dialog's selects by its label and picks the option with this text. */
const pick = async (host: HTMLElement, label: string, option: string) => {
  await click(host.querySelector(`[aria-label="${label}"]`));
  await click(byText(host, option, '[role=menuitem]'));
};
const sel = (host: HTMLElement, label: string) => host.querySelector(`[aria-label="${label}"]`)!.textContent;
const savedTask = () => calls.filter((c) => c[0] === 'save').at(-1)![1];

export {
  assert,
  fx,
  h,
  act,
  calls,
  store,
  sessions,
  next,
  changedListeners,
  changed,
  Scheduled,
  ScheduledNav,
  task,
  both,
  navNames,
  dialog,
  pick,
  sel,
  savedTask,
  render,
  click,
  byText,
  maybeText,
  type,
  flush,
};
