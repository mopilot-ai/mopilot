// Scheduled-task editing dialog with repeat/time and execution controls.
import { useEffect, useState } from 'react';
import { prefixCodePoints } from '../../../../shared/textPrefix.mjs';
import { useStore } from '../../../store/core';
import {
  approvalOf,
  computerAllowed,
  isBasicRunWith,
  modelsFor,
  runWithChoices,
  runWithLabel,
  runWithOf,
  runWithWhere,
  type OnApproval,
  type RunWith,
} from '../../../lib/scheduleTask';
import { type Automation } from '../../../lib/automations';
import { modelLabel, effortLabel } from '../../../lib/format';
import { X, ChevronDown, ChevronUp } from '../../ui/icons';
import { imeComposing } from '../../../lib/focus';
import { useHostMachines } from '../../../lib/hostMachines';
import { THIS_MAC, agentIdOf, machineRunWith } from '../../../lib/scheduleMachine';
import { SchedSelect, Toggle } from './controls';
import { RunsOnField } from './RunsOnField';

type Repeat = 'interval' | 'daily' | 'weekdays' | 'weekly' | 'custom';
const DAYS = ['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU'];
const DAY_LABEL: Record<string, string> = {
  MO: 'Monday',
  TU: 'Tuesday',
  WE: 'Wednesday',
  TH: 'Thursday',
  FR: 'Friday',
  SA: 'Saturday',
  SU: 'Sunday',
};
const tzAbbr = () =>
  new Intl.DateTimeFormat('en-US', { timeZoneName: 'shortGeneric' }).formatToParts(new Date()).find((p) => p.type === 'timeZoneName')
    ?.value ?? '';
const fmtTime = (h: number, m: number) => `${((h + 11) % 12) + 1}:${String(m).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`;

/** Parse an RRULE into the dialog's Repeat/Time controls. */
function parseRule(rule: string) {
  const get = (k: string) => new RegExp(`${k}=([^;]+)`).exec(rule)?.[1];
  const freq = get('FREQ');
  const hour = Number(get('BYHOUR') ?? 9);
  const minute = Number(get('BYMINUTE') ?? 0);
  const days = get('BYDAY')?.split(',') ?? [];
  let repeat: Repeat = 'custom';
  if (freq === 'HOURLY' || freq === 'MINUTELY') repeat = 'interval';
  else if (freq === 'DAILY') repeat = 'daily';
  else if (freq === 'WEEKLY' && days.join(',') === 'MO,TU,WE,TH,FR') repeat = 'weekdays';
  else if (freq === 'WEEKLY' && days.length === 1) repeat = 'weekly';
  return {
    repeat,
    hour,
    minute,
    day: days[0] ?? 'MO',
    every: Number(get('INTERVAL') ?? 1),
    unit: freq === 'MINUTELY' ? 'MINUTELY' : 'HOURLY',
  };
}

/** "Schedule a task": the official modal (instructions, repeat, time, advanced). */
export function ScheduleDialog({
  initial,
  onCancel,
  onSave,
}: {
  initial: Automation;
  onCancel: () => void;
  onSave: (a: Automation) => void;
}) {
  const codexModels = useStore((s) => s.models);
  const basics = useStore((s) => s.basicHarnesses);
  const claudeModels = useStore((s) => s.claude.models);
  const config = useStore((s) => s.config);
  const basicDefaults = useStore((s) => s.prefs.basicDefaults);
  const savedProjects = useStore((s) => s.savedProjects);
  const hostFolders = useStore((s) => s.prefs.hostFolders);
  const { machines } = useHostMachines();
  // "Runs on": this Mac, or a machine with a folder there (the task's cwds hold the machine's folder then)
  const initialHost = typeof initial.host_id === 'string' && initial.host_id ? initial.host_id : THIS_MAC;
  const [runsOn, setRunsOn] = useState(initialHost);
  const [hostFolder, setHostFolder] = useState(initialHost === THIS_MAC ? '' : (initial.cwds?.[0] ?? ''));
  const onMachine = runsOn !== THIS_MAC;
  const machine = machines.find((m) => m.id === runsOn);
  const p0 = parseRule(initial.rrule);
  const [harness, setHarness] = useState<RunWith>(runWithOf(initial));
  const [computer, setComputer] = useState(computerAllowed(initial));
  const [onApproval, setOnApproval] = useState<OnApproval>(approvalOf(initial));
  const [prompt, setPrompt] = useState(initial.prompt);
  const [repeat, setRepeat] = useState<Repeat>(p0.repeat);
  const [time, setTime] = useState(p0.hour * 60 + p0.minute);
  const [day, setDay] = useState(p0.day);
  const [every, setEvery] = useState(p0.every);
  const [unit, setUnit] = useState(p0.unit);
  const [custom, setCustom] = useState(initial.rrule);
  const [advanced, setAdvanced] = useState(false);
  const [local, setLocal] = useState((initial.execution_environment ?? 'local') === 'local');
  const [newChat, setNewChat] = useState(initial.id ? initial.kind !== 'heartbeat' : false);
  // the model list is the chosen harness's; switching harness picks that harness's default
  const src = {
    codexModels,
    claudeModels,
    codexModel: config?.model,
    codexEffort: config?.model_reasoning_effort,
    basics,
    basicDefaults,
  };
  const choices = modelsFor(harness, src, modelLabel).picks;
  // modelsFor always names a model ('' when the harness lists none)
  const [model, setModel] = useState(initial.model ?? modelsFor(harness, src, modelLabel).model);
  const [effort, setEffort] = useState(initial.reasoning_effort ?? modelsFor(harness, src, modelLabel).effort);
  const pickHarness = (h: RunWith) => {
    setHarness(h);
    const d = modelsFor(h, src, modelLabel);
    setModel(d.model);
    setEffort(d.effort);
  };
  const harnessChoices = onMachine
    ? machineRunWith(machine)
    : runWithChoices(basics).map((r) => ({ id: r.id, label: r.label, note: r.note, disabled: r.disabled }));
  const harnessLabel = (onMachine && machine?.agents.find((a) => a.id === agentIdOf(harness))?.label) || runWithLabel(harness, basics);
  const pickRunsOn = (id: string) => {
    setRunsOn(id);
    if (id === THIS_MAC) return;
    // the folder last used on that machine, as the composer starts there; an agent it doesn't have gives way to one it has
    setHostFolder(hostFolders[id] ?? '');
    const there = machineRunWith(machines.find((m) => m.id === id));
    if (there.length && !there.some((c) => c.id === harness)) pickHarness(there[0].id);
  };
  // the project a machine task lists its chats under: the one whose folder the task was made in
  // a task moved back from a machine runs in its project's folder here (none: the home folder)
  const projectRoot = savedProjects.find((p) => p.id === initial.project_id)?.roots[0]?.path;
  const localCwds = initialHost === THIS_MAC ? initial.cwds : projectRoot ? [projectRoot] : undefined;
  const projectId = localCwds?.[0] ? (savedProjects.find((p) => p.roots.some((r) => r.path === localCwds[0]))?.id ?? undefined) : undefined;
  const h = Math.floor(time / 60);
  const m = time % 60;
  const rule =
    repeat === 'interval'
      ? `FREQ=${unit};INTERVAL=${Math.max(1, every)}`
      : repeat === 'daily'
        ? `FREQ=DAILY;BYHOUR=${h};BYMINUTE=${m}`
        : repeat === 'weekdays'
          ? `FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR;BYHOUR=${h};BYMINUTE=${m}`
          : repeat === 'weekly'
            ? `FREQ=WEEKLY;BYDAY=${day};BYHOUR=${h};BYMINUTE=${m}`
            : custom;
  const picked = choices.find((x) => x.id === model);
  const efforts = picked?.efforts ?? [];
  // a basic harness names its thought levels itself; Codex and Claude Code levels go by effortLabel
  const effortNames = picked?.effortNames ?? {};
  const save = () =>
    onSave({
      ...initial,
      name: initial.name || prefixCodePoints(prompt.split('\n')[0], 60),
      prompt,
      rrule: rule,
      kind: newChat ? 'cron' : 'heartbeat',
      execution_environment: local ? 'local' : 'worktree',
      model: model || undefined,
      reasoning_effort: effort || undefined,
      harness,
      computer_control: computer,
      on_approval: onApproval,
      ...(onMachine
        ? { host_id: runsOn, cwds: [hostFolder], project_id: initial.project_id ?? projectId, execution_environment: 'local' }
        : { host_id: undefined, cwds: localCwds, project_id: undefined }),
    });
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === 'Escape' && !imeComposing(e) && !document.querySelector('.popover-layer') && onCancel();
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [onCancel]);
  return (
    <div className="sched-dialog-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onCancel()}>
      <div className="sched-dialog" role="dialog" aria-label="Schedule a task">
        <div className="sched-dialog-head">
          <span>{initial.id ? 'Edit task' : 'Schedule a task'}</span>
          <button className="icon-btn" onClick={onCancel} aria-label="Close dialog">
            <X size={16} />
          </button>
        </div>
        <textarea
          className="sched-instructions"
          autoFocus
          placeholder="Instructions..."
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
        />
        <div className="sched-card">
          <div className="sched-field">
            <span>Repeat</span>
            <SchedSelect
              label="Repeat schedule"
              value={repeat}
              options={[
                ['interval', 'Interval'],
                ['daily', 'Daily'],
                ['weekdays', 'Weekdays'],
                ['weekly', 'Weekly'],
                ['custom', 'Custom'],
              ]}
              onChange={(v) => setRepeat(v as Repeat)}
            />
          </div>
          {repeat === 'interval' ? (
            <div className="sched-field">
              <span>Every</span>
              <span className="sched-inline">
                <input
                  className="text-input slim num"
                  type="number"
                  min={1}
                  value={every}
                  onChange={(e) => setEvery(Number(e.target.value) || 1)}
                />
                <SchedSelect
                  label="Unit"
                  value={unit}
                  options={[
                    ['HOURLY', 'hours'],
                    ['MINUTELY', 'minutes'],
                  ]}
                  onChange={setUnit}
                />
              </span>
            </div>
          ) : repeat === 'custom' ? (
            <div className="sched-field">
              <span>Rule</span>
              <input className="text-input slim wide mono" value={custom} onChange={(e) => setCustom(e.target.value)} />
            </div>
          ) : (
            <>
              {repeat === 'weekly' && (
                <div className="sched-field">
                  <span>Day</span>
                  <SchedSelect label="Day" value={day} options={DAYS.map((d) => [d, DAY_LABEL[d]])} onChange={setDay} />
                </div>
              )}
              <div className="sched-field">
                <span>Time</span>
                <SchedSelect
                  label="Time"
                  value={String(time)}
                  options={Array.from(
                    { length: 96 },
                    (_, i) => [String(i * 15), fmtTime(Math.floor(i / 4), (i % 4) * 15)] as [string, string],
                  )}
                  display={`${fmtTime(h, m)} ${tzAbbr()}`}
                  onChange={(v) => setTime(Number(v))}
                />
              </div>
            </>
          )}
          {(machines.length > 0 || onMachine) && (
            <RunsOnField
              machines={machines}
              runsOn={runsOn}
              folder={hostFolder}
              harness={harness}
              harnessLabel={harnessLabel}
              onRunsOn={pickRunsOn}
              onFolder={setHostFolder}
            />
          )}
        </div>
        <button className="sched-advanced" onClick={() => setAdvanced((x) => !x)} aria-label="Advanced">
          Advanced {advanced ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
        </button>
        {advanced && (
          <div className="sched-adv">
            <div className="sched-card single">
              <div className="sched-field">
                <span>Run with</span>
                <SchedSelect
                  label="Run with"
                  value={harness}
                  options={harnessChoices.map((r) => ({ value: r.id, label: r.label, hint: r.note || undefined, disabled: r.disabled }))}
                  display={harnessLabel}
                  onChange={(v) => pickHarness(v as RunWith)}
                />
              </div>
              {!onMachine && <div className="sched-field sched-where-note">{runWithWhere(harness, runWithLabel(harness, basics))}</div>}
            </div>
            {/* a run on a machine uses the folder picked there */}
            {!onMachine && (
              <div className="sched-card single">
                <div className="sched-field">
                  <span>Run on this computer</span>
                  <Toggle on={local} onChange={setLocal} label="Run on this computer" />
                </div>
              </div>
            )}
            <div className="sched-card single">
              <div className="sched-field">
                <span>Start each run in new chat</span>
                <Toggle on={newChat} onChange={setNewChat} label="Start each run in new chat" />
              </div>
            </div>
            {/* a basic harness that declares no model (or hasn't said yet) runs on its own */}
            {choices.length === 0 && isBasicRunWith(harness) && (
              <div className="sched-card single">
                <div className="sched-field">
                  <span>Model</span>
                  <span className="sched-field-note">Uses the model set in {runWithLabel(harness, basics)}</span>
                </div>
              </div>
            )}
            {choices.length > 0 && (
              <>
                <div className="sched-card single">
                  <div className="sched-field">
                    <span>Model</span>
                    <SchedSelect
                      label="Model"
                      value={model}
                      options={choices.map((x) => [x.id, x.label] as [string, string])}
                      onChange={setModel}
                    />
                  </div>
                </div>
                {/* a basic harness without thought levels has no effort to choose; Codex and Claude show one as is */}
                {(efforts.length > 0 || !isBasicRunWith(harness)) && (
                  <div className="sched-card single">
                    <div className="sched-field">
                      <span>Effort</span>
                      <SchedSelect
                        label="Reasoning"
                        value={effort}
                        options={efforts.map((e) => [e, effortNames[e] ?? effortLabel(e)] as [string, string])}
                        onChange={setEffort}
                      />
                    </div>
                  </div>
                )}
              </>
            )}
            <div className="sched-card single">
              <div className="sched-field">
                <span>Allow computer control</span>
                <Toggle on={computer} onChange={setComputer} label="Allow computer control" />
              </div>
            </div>
            <div className="sched-card single">
              <div className="sched-field">
                <span>When approval is needed</span>
                <SchedSelect
                  label="When approval is needed"
                  value={onApproval}
                  options={[
                    ['wait', 'Wait and notify'],
                    ['skip', 'Skip this run'],
                  ]}
                  onChange={(v) => setOnApproval(v as OnApproval)}
                />
              </div>
            </div>
          </div>
        )}
        <div className="sched-dialog-foot">
          <button className="btn-pill soft lg" onClick={onCancel}>
            Cancel
          </button>
          <button className="btn-white lg" disabled={!prompt.trim() || (onMachine && !hostFolder)} onClick={save}>
            {initial.id ? 'Save' : 'Create'}
          </button>
        </div>
      </div>
    </div>
  );
}
