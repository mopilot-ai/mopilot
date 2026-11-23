// Scheduled tasks: which harness runs one, what a run may do, and how a run starts. The fields a run
// reads are shared/scheduleTask.mjs (main starts the runs: electron/platform/automationRun.cjs); this
// file re-exports them and keeps what the Scheduled page needs. The fields sit in the task's
// automation.toml next to the ones Codex's own app writes; Codex ignores keys it doesn't know.
import { ownTable } from '../../shared/ownTable.mjs';
import { selectValues } from '../../shared/acpMode.mjs';
import type { RunWith } from '../../shared/scheduleTask.mjs';
import type { AcpCatalog } from '../../shared/model/harness';

export type { RunWith, OnApproval, TaskFields } from '../../shared/scheduleTask.mjs';
export {
  runWithOf,
  acpHarnessOf,
  computerAllowed,
  approvalOf,
  scheduledMark,
  wantsWorktree,
  runSendOptions,
} from '../../shared/scheduleTask.mjs';

/** "Run with": the two first-class harnesses, then the basic ones (runWithChoices). */
export const RUN_WITH: { id: RunWith; label: string }[] = [
  { id: 'codex', label: 'Codex' },
  { id: 'claude', label: 'Claude Code' },
];

/** A "Run with" option: where it runs, or why it can't run a task now. */
export interface RunWithChoice {
  id: RunWith;
  label: string;
  note: string;
  disabled: boolean;
}

/** Why an installed basic harness can't run a task now (an uninstalled one isn't offered). */
const UNAVAILABLE: Record<string, string> = {
  signin: 'Sign in to use',
  unsupported: "Can't run in MoPilot",
  off: 'Turned off for now',
  checking: 'Checking…',
};

/**
 * Every harness a task can run with: Codex, Claude Code and each admitted basic harness, then the installed
 * basic ones that can't run yet, disabled with why.
 */
export function runWithChoices(basics: { id: string; label: string; state: string }[]): RunWithChoice[] {
  const ok = basics.filter((b) => b.state === 'admitted');
  const not = basics.filter((b) => Object.hasOwn(UNAVAILABLE, b.state));
  return [
    { id: 'codex', label: 'Codex', note: 'Also runs in the Codex app', disabled: false },
    { id: 'claude', label: 'Claude Code', note: 'Also runs in Claude Desktop', disabled: false },
    ...ok.map((b) => ({ id: `acp:${b.id}` as RunWith, label: b.label, note: 'MoPilot only', disabled: false })),
    ...not.map((b) => ({ id: `acp:${b.id}` as RunWith, label: b.label, note: UNAVAILABLE[b.state], disabled: true })),
  ];
}

/** Whether a task runs with a basic (ACP) harness: any that isn't a first-tier one (RUN_WITH), never by its id's spelling. */
export const isBasicRunWith = (h: RunWith) => !RUN_WITH.some((r) => r.id === h);

/** The name of the harness a task runs with; a basic one that isn't installed now still shows its id. */
export const runWithLabel = (h: RunWith, basics: { id: string; label: string }[]) =>
  RUN_WITH.find((r) => r.id === h)?.label ?? basics.find((b) => `acp:${b.id}` === h)?.label ?? h.slice(4);

/** Where a task on a harness with a native app of its own runs; a basic harness has none (runWithWhere). */
const WHERE: Partial<Record<RunWith, string>> = ownTable({
  codex: 'Runs while MoPilot or the Codex app is open. Each time runs once: whichever app is open runs it.',
  claude: 'Runs while MoPilot or Claude Desktop is open. MoPilot adds it to Claude Desktop the next time Claude Desktop is closed.',
});

/** Where a task on this harness runs, for the dialog. */
export function runWithWhere(h: RunWith, label: string): string {
  return (
    WHERE[h] ??
    `Runs only while MoPilot is open: ${label} has no scheduler of its own. A time missed while it was closed runs once when it opens, within 7 days.`
  );
}

export type RunApp = 'mopilot' | 'codex-app' | 'claude-desktop';
export const APP_LABEL: Record<RunApp, string> = { mopilot: 'MoPilot', 'codex-app': 'Codex app', 'claude-desktop': 'Claude Desktop' };

/** Whether the scheduler is on, and the native apps that run tasks too (main's automation:apps). */
export interface AppsState {
  scheduler: boolean;
  codexApp: { installed: boolean; running: boolean };
  claudeDesktop: { installed: boolean; running: boolean };
}

/** "Where it runs" on a task's page: each app that runs it, and what it is doing about it now. */
export function whereItRuns(
  r: { apps: string[]; desktop?: string; transfer?: string } | undefined,
  apps: AppsState | null,
): { app: RunApp; name: string; line: string }[] {
  if (r?.transfer) return [{ app: 'mopilot', name: 'MoPilot', line: runsInLabel(r) }];
  const list = (r?.apps ?? ['mopilot']) as RunApp[];
  const native = list.find((a): a is 'codex-app' | 'claude-desktop' => a !== 'mopilot');
  const state = native === 'codex-app' ? apps?.codexApp : native === 'claude-desktop' ? apps?.claudeDesktop : undefined;
  const nativeName = native === 'codex-app' ? 'the Codex app' : 'Claude Desktop';
  const out: { app: RunApp; name: string; line: string }[] = [];
  if (list.includes('mopilot')) {
    let line = 'Runs this task while MoPilot is open';
    if (apps && !apps.scheduler) line = 'Off in Settings: doesn’t run tasks';
    else if (native && state?.running) line = `Waiting: ${nativeName} is open and runs this task`;
    else if (native) line = `Runs this task while ${nativeName} is closed, and records each run there`;
    else if (r?.desktop) line = runsInLabel(r);
    out.push({ app: 'mopilot', name: 'MoPilot', line });
  }
  if (native)
    out.push({
      app: native,
      name: APP_LABEL[native],
      line: !state
        ? 'Runs this task while it is open'
        : !state.installed
          ? 'Not installed'
          : state.running
            ? 'Open now: runs this task itself'
            : 'Closed: won’t run a time MoPilot already ran',
    });
  return out;
}

/** Where a task runs, in a line: MoPilot, and the native app that runs it too. */
export function runsInLabel(r: { apps: string[]; desktop?: string; transfer?: string } | undefined): string {
  if (r?.transfer) return 'Waiting to finish switching this task. Close its previous app if it is open.';
  const apps = r?.apps ?? ['mopilot'];
  if (!apps.includes('mopilot')) {
    const named = [
      apps.includes('codex-app') && 'the Codex app',
      (apps.includes('claude-desktop') || apps.length === 0) && 'Claude Desktop',
    ];
    return `Runs in ${named.filter(Boolean).join(' and ')} only: MoPilot can’t read this schedule`;
  }
  if (apps.includes('codex-app')) return 'Runs from MoPilot or the Codex app, once per time';
  if (apps.includes('claude-desktop')) return 'Runs from MoPilot or Claude Desktop, once per time';
  switch (r?.desktop) {
    case 'pending':
      return 'Runs from MoPilot; it joins Claude Desktop once Claude Desktop is closed';
    case 'unsupported-schedule':
      return 'Runs from MoPilot only: Claude Desktop can’t run this schedule';
    case 'unavailable':
      return 'Runs from MoPilot only: this version of Claude Desktop isn’t supported';
    case 'missing':
      return 'Runs from MoPilot only: it was removed from Claude Desktop';
    default:
      return 'Runs while MoPilot is open';
  }
}

/** Settings' list of the native apps that run tasks too: the installed ones, open or closed, and what that means. */
export function appStatusRows(
  apps: AppsState | null,
  tasks: { native_app?: string | null; status: string; claude_desktop?: string }[],
  schedulerOn: boolean,
): { app: RunApp; name: string; open: boolean; detail: string }[] {
  if (!apps) return [];
  const tasksOf = (n: number) => `${n} active ${n === 1 ? 'task' : 'tasks'}`;
  const out: { app: RunApp; name: string; open: boolean; detail: string }[] = [];
  for (const [app, state] of [
    ['codex-app', apps.codexApp],
    ['claude-desktop', apps.claudeDesktop],
  ] as const) {
    if (!state.installed) continue;
    const n = tasks.filter((t) => t.native_app === app && t.status === 'ACTIVE').length;
    const pending = app === 'claude-desktop' ? tasks.filter((t) => t.claude_desktop === 'pending').length : 0;
    let detail = state.running
      ? `Runs its ${tasksOf(n)} itself`
      : schedulerOn
        ? `MoPilot runs its ${tasksOf(n)} and records each run there`
        : 'Its tasks wait until it opens';
    if (pending) detail += `. ${pending} new ${pending === 1 ? 'task joins' : 'tasks join'} it once it closes`;
    out.push({ app, name: APP_LABEL[app], open: state.running, detail });
  }
  return out;
}

/** A recorded scheduled time, as its row in Recent runs shows it. */
export function runRow(
  r: { status?: string; reason?: string; catchUp?: boolean },
  chatTitle: string | null,
): { status: string; tone: 'ran' | 'catchup' | 'skipped' | 'failed'; detail: string } {
  if (r.status === 'failed') return { status: 'Didn’t start', tone: 'failed', detail: r.reason || 'Unknown error' };
  if (r.status === 'skipped') {
    if (r.reason === 'missed') return { status: 'Missed', tone: 'skipped', detail: 'Nothing was open, and a later time ran instead' };
    if (r.reason === 'previous-running') return { status: 'Skipped', tone: 'skipped', detail: 'The previous run was still going' };
    return { status: 'Skipped', tone: 'skipped', detail: '' };
  }
  if (r.status === 'needs-approval')
    return { status: 'Needs approval', tone: 'skipped', detail: chatTitle ?? 'It stopped at a step that needs you' };
  if (r.status === 'starting') return { status: 'Starting', tone: 'ran', detail: chatTitle ?? '' };
  if (r.catchUp) return { status: 'Catch-up', tone: 'catchup', detail: chatTitle ?? 'A missed time, run when MoPilot opened' };
  return { status: 'Ran', tone: 'ran', detail: chatTitle ?? '' };
}

/** Which app or machine a recorded run was in: the Codex app, the machine that fired it, MoPilot, or none for a missed time. */
export function runSource(r: { by?: unknown; reason?: string }, machineName: (id: string) => string = (id) => id): string {
  if (r.by === 'codex-app') return 'Codex app';
  // a run the machine fired itself while this Mac was away (#2709 phase 2) names that machine
  const machine = (r.by as { machine?: unknown } | undefined)?.machine;
  if (typeof machine === 'string' && machine) return machineName(machine);
  return r.reason === 'missed' ? '' : 'MoPilot';
}

export { anchorDays, ATTENTION_MS, CATCH_UP_MS } from '../../shared/schedule.mjs';

/** One model a task can run with, whichever harness lists it. */
export interface ModelPick {
  id: string;
  label: string;
  efforts: string[];
  /** a basic harness's own names for its thought levels; the others are named by effortLabel */
  effortNames?: Record<string, string>;
}

/** What the dialog knows about each harness's models and the user's Codex defaults. */
export interface ModelSources {
  codexModels: { model: string; displayName: string; supportedReasoningEfforts?: { reasoningEffort: string }[] }[];
  claudeModels: { id: string; label: string; efforts: string[]; isDefault?: boolean; defaultEffort?: string | null }[];
  codexModel?: string;
  codexEffort?: string;
  /** each basic harness's catalog: the config options its last new session declared */
  basics?: { id: string; catalog?: AcpCatalog | null }[];
  /** the config values new chats on each basic harness start with (prefs basicDefaults) */
  basicDefaults?: Record<string, { config?: Record<string, unknown> } | undefined>;
}

/** The models a task's harness offers, and the model and effort a task starts with when that harness is picked. */
const MODELS: Record<
  'codex' | 'claude',
  (s: ModelSources, label: (name: string) => string) => { picks: ModelPick[]; model: string; effort: string }
> = {
  codex: (s, label) => {
    const picks = s.codexModels.map((m) => ({
      id: m.model,
      label: label(m.displayName),
      efforts: (m.supportedReasoningEfforts ?? []).map((e) => e.reasoningEffort),
    }));
    return {
      picks,
      model: (s.codexModels.find((m) => m.model === s.codexModel) ?? s.codexModels[0])?.model ?? s.codexModel ?? '',
      effort: s.codexEffort ?? 'medium',
    };
  },
  claude: (s) => {
    const picks = s.claudeModels.map((m) => ({ id: m.id, label: m.label, efforts: m.efforts }));
    const d = s.claudeModels.find((m) => m.isDefault) ?? s.claudeModels[0];
    return { picks, model: d?.id ?? '', effort: d?.defaultEffort ?? '' };
  },
};

/** A harness that declares no model (or hasn't said yet): the dialog offers none, and the run sends none. */
const NO_MODELS = { picks: [] as ModelPick[], model: '', effort: '' };

/**
 * A basic harness's models and thought levels: the select config options of category model and thought_level its
 * catalog declares, starting on the values new chats on it start with (else the agent's own). The run sets them on
 * its session before the prompt (electron/harness/acp/initialConfig.cjs).
 */
function basicModels(h: RunWith, s: ModelSources) {
  const id = /^acp:(.+)$/.exec(h)?.[1] ?? '';
  const options = s.basics?.find((b) => b.id === id)?.catalog?.configOptions ?? [];
  const chosen = s.basicDefaults?.[id]?.config ?? {};
  const of = (category: string) => {
    const opt = options.find((o) => o.category === category && o.type === 'select');
    const values = selectValues(opt).map((v) => ({ id: String(v.value), name: v.name || String(v.value) }));
    const want = opt ? String(chosen[opt.id] ?? opt.currentValue) : '';
    return { values, current: values.some((v) => v.id === want) ? want : (values[0]?.id ?? '') };
  };
  const model = of('model');
  if (!model.values.length) return NO_MODELS;
  const effort = of('thought_level');
  const efforts = effort.values.map((v) => v.id);
  const effortNames = Object.fromEntries(effort.values.map((v) => [v.id, v.name]));
  return {
    picks: model.values.map((v) => ({ id: v.id, label: v.name, efforts, effortNames })),
    model: model.current,
    effort: effort.current,
  };
}

export const modelsFor = (h: RunWith, s: ModelSources, label: (name: string) => string) =>
  Object.hasOwn(MODELS, h) ? MODELS[h as keyof typeof MODELS](s, label) : basicModels(h, s);
