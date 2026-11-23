// Collapsed and running work groups, including agent groups and screenshot control runs.
import { ActivityTime } from '../ActivityTime';
import { Collapse } from '../../ui/Presence';
import { memo, useCallback, useContext, useMemo, useState } from 'react';
import { RunningCommand } from '../RunningCommand';
import { AgentChatContext, AgentGroup, hasAgentRun } from '../../agents/AgentGroup';
import { InlineCounts } from '../../tasks/SessionsCount';
import { ClaudeActivity } from '../ClaudeActivity';
import { InStatusSlot, useStatusSlot } from '../statusSlot';
import { activityRowText, claudeActivityParts, type ActivityUx } from '../../../session/activityUx';
import { markActivity } from '../../../session/activityWords';
import { useMinDwell } from '../../../lib/minDwell';
import { ZoomableImage } from '../../ui/ImageLightbox';
import { prettyCommand } from '../../../lib/format';
import { useStore } from '../../../store/core';
import { visibleSteps } from '../../../lib/reasoning';
import { controlThumbnail, type NarrationContext } from '../../../lib/agentNarration';
import { appIcon, appLabel, useAppNamesVersion } from '../../../lib/appNames';
import { MousePointerClick, ThinkingDots } from '../../ui/icons';
import {
  itemSteps,
  narrateSteps,
  stepControl,
  controlRuns,
  summarizeSteps,
  stepKeys,
  controlShots,
  mergeThoughtSteps,
  thoughtItems,
  controlWords,
  type DisplayItem,
  type Step,
  type WithStatus,
} from './stepModel';
import { Shimmer, stepIcon, activeStepLabel, waitWords, useNow } from './presentation';
import { useTurnTiming, type TurnTiming } from './turnTiming';
import { GroupLiveLink, StepRow } from './StepRow';
import { StepSummary } from './StepSummary';
import { ShellBox } from './output';
type StepGroupProps = {
  items: DisplayItem[];
  cwd: string;
  active: boolean;
  ux?: ActivityUx;
  elapsedMs?: number | null;
  /** no clock beside the running step: the agent page runs no turn of its own to time */
  hideTime?: boolean;
  /** the app bindings Codex's computer-use programs left before this group (earlier groups and turns) */
  narration?: NarrationContext;
};

/** Two narration contexts binding the same apps (the turn recomputes them, as new maps, on every delta). */
export const sameNarration = (a: NarrationContext | undefined, b: NarrationContext | undefined) =>
  a === b ||
  (!!a &&
    !!b &&
    a.size === b.size &&
    [...a].every(([key, binding]) => {
      const other = b.get(key);
      return !!other && other.surface === binding.surface && other.app === binding.app;
    }));

/**
 * Whether a group shows the same: the turn rebuilds each group's items array on every delta, but a settled group holds
 * the same item objects; and only the running group shows the clock.
 */
export const sameStepGroup = (a: StepGroupProps, b: StepGroupProps) =>
  a.cwd === b.cwd &&
  a.active === b.active &&
  a.ux === b.ux &&
  a.hideTime === b.hideTime &&
  (!b.active || a.elapsedMs === b.elapsedMs) &&
  a.items.length === b.items.length &&
  a.items.every((item, i) => item === b.items[i]) &&
  sameNarration(a.narration, b.narration);

/**
 * A run of steps: a group with agent launches is an agent group (its agents open their pages), any other a step group.
 * Memoized by sameStepGroup, so a streamed delta re-renders the running group, not every group of the turn.
 */
export const StepGroup = memo(function StepGroup(props: StepGroupProps) {
  const showReasoning = useStore((s) => s.prefs.showReasoning);
  const steps = useMemo(() => props.items.flatMap(itemSteps), [props.items]);
  const cur = currentStep(steps);
  // which thoughts are open, held here so a thought keeps it when an agent launch changes the group's renderer
  const thoughts = useThoughtDisclosures();
  const agents = hasAgentRun(props.items);
  // Claude Desktop's running group is one row that opens to its steps, thoughts among them; an agent group and the
  // shimmer look list the running group's thoughts above it. The running group shows no row for a finished tool other
  // than browser and desktop control (its run sits below), so its thoughts have nothing shown between them: one row
  // for the stretch, which names the step running or, between steps, the last one.
  const oneRow = props.active && (props.ux ?? 'shimmer') === 'dots' && (!agents || !props.hideTime);
  const reasoning =
    props.active && !oneRow ? mergeThoughtSteps(visibleSteps(steps, showReasoning).filter((step) => step.kind === 'reasoning')) : [];
  // a merged row keeps its first thought's key: keys count each item id on its own
  const keys = stepKeys(reasoning);
  return (
    <>
      {reasoning.map((step) => (
        <StepRow
          key={keys.get(step)}
          step={step}
          cwd={props.cwd}
          running={step.kind === 'reasoning' && thoughtItems(step).some((t) => t === cur?.item)}
          disclosure={thoughts.of(step)}
        />
      ))}
      {agents ? (
        <AgentGroup
          items={props.active && !oneRow ? props.items.filter((item) => item.type !== 'reasoning') : props.items}
          cwd={props.cwd}
          active={props.active}
          elapsedMs={props.hideTime ? null : (props.elapsedMs ?? null)}
          hideTime={props.hideTime}
          disclosures={thoughts}
          narration={props.narration}
        />
      ) : (
        <PlainStepGroup {...props} thoughts={thoughts} />
      )}
    </>
  );
}, sameStepGroup);

/** Prefer a still-running operation when parallel tools complete out of order. */
function currentStep(steps: Step[]) {
  return [...steps].reverse().find((step) => (step.item as WithStatus).status === 'inProgress') ?? steps.at(-1);
}

/** A browser or desktop step that finished: it shows as it lands, above the running line. */
const landedControl = (s: Step) => !!stepControl(s) && (s.item as WithStatus).status !== 'inProgress';
/** A tool step still running: the running line names it rather than listing it. */
const runningTool = (s: Step) => s.kind !== 'reasoning' && (s.item as WithStatus).status === 'inProgress';

/**
 * The step a running group's line names: a tool running now (the latest, even while the model thinks beside it), else
 * the group's last tool, as Claude Desktop's row holds the last step's words while the model thinks between steps (a
 * turn of short tools would read "Thinking…" for minutes otherwise). Undefined before the group's first tool, when the
 * line says "Thinking…".
 */
function heldStep(steps: Step[]): Step | undefined {
  return steps.findLast(runningTool) ?? steps.findLast((s) => s.kind !== 'reasoning');
}

/** A held step's words on the running row: a wait's countdown, a browser or desktop step's own, else Claude Code's running form. */
function heldWords(step: Step, timing: TurnTiming, now: number): string {
  if (step.kind === 'wait') return waitWords(step, timing.timeOf(step.item.id), now);
  const control = stepControl(step);
  return activityRowText(control ? { verb: control.doing } : claudeActivityParts(step));
}

/** The row's words wait out their dwell; leaving "Thinking…" for the group's first step is at once. */
const ROW_DWELL = { restKey: '' };

export type ThoughtDisclosures = {
  of: (step: Step) => { open: boolean; toggle: () => void };
  group: { open: boolean; toggle: () => void };
};

/**
 * The open thoughts of a group, by each thought row's first thought: the same in the running row's list, where a tool
 * between two thoughts keeps them apart, and in an agent group's thoughts, where they merge.
 */
function useThoughtDisclosures(): ThoughtDisclosures {
  const [open, setOpen] = useState<ReadonlySet<string>>(() => new Set());
  const [groupOpen, setGroupOpen] = useState(false);
  const toggleGroup = useCallback(() => setGroupOpen((was) => !was), []);
  const toggle = useCallback(
    (id: string) =>
      setOpen((was) => {
        const next = new Set(was);
        if (!next.delete(id)) next.add(id);
        return next;
      }),
    [],
  );
  return useMemo(
    () => ({
      group: { open: groupOpen, toggle: toggleGroup },
      // a merged row keeps its first thought as its item
      of: (step) => ({ open: open.has(step.item.id), toggle: () => toggle(step.item.id) }),
    }),
    [open, toggle, groupOpen, toggleGroup],
  );
}

function PlainStepGroup({
  items,
  cwd,
  active,
  ux = 'shimmer',
  elapsedMs = null,
  hideTime = false,
  narration,
  thoughts,
}: StepGroupProps & { thoughts: ThoughtDisclosures }) {
  const showReasoning = useStore((s) => s.prefs.showReasoning);
  // a step names its app once main resolved it (lib/appNames.ts): the narration runs again then
  const names = useAppNamesVersion();
  const steps = useMemo(() => {
    void names;
    return narrateSteps(items.flatMap(itemSteps), items, narration);
  }, [items, narration, names]);
  const visible = mergeThoughtSteps(visibleSteps(steps, showReasoning));
  const [open, setOpen] = useState(false);

  if (active) {
    // Finished browser and desktop steps show as they land, as the Codex app and Claude Desktop list each call (#1952):
    // a code-mode program's calls finish in a fraction of a second, so the running line alone would read "Thinking".
    const landed = steps.filter(landedControl);
    const run = landed.length > 1 ? <ControlRun steps={landed} cwd={cwd} /> : landed.length ? <StepRow step={landed[0]} cwd={cwd} /> : null;
    return (
      <>
        {run}
        <RunningLine
          items={items}
          steps={steps}
          listed={visible.filter((s) => !landedControl(s) && !runningTool(s))}
          cwd={cwd}
          ux={ux}
          elapsedMs={elapsedMs}
          hideTime={hideTime}
          thoughts={thoughts}
        />
      </>
    );
  }
  if (!visible.length) return null;
  // a call standing alone between two replies shows its screenshots below it (Claude Desktop's hoisted images)
  if (visible.length === 1) return <StepRow step={visible[0]} cwd={cwd} shots />;
  const runs = controlRuns(visible);
  // a group that is all browser or desktop control is one run: "Used the browser · 7 steps"
  if (runs.length === 1 && runs[0].kind === 'control') return <ControlRun steps={runs[0].steps} cwd={cwd} />;
  // keys count each item id on its own, so showing, hiding or merging thoughts leaves each open row on its own step
  const keys = stepKeys(visible);
  const sum = summarizeSteps(visible);
  // the latest browser or desktop screenshots of the group, so a collapsed group still shows where it ended
  const thumbs = controlShots(visible);
  return (
    <div className={`step-group ${open ? 'open' : ''}`}>
      <StepSummary open={open} onToggle={() => setOpen((o) => !o)} icon={stepIcon(sum.icon as Step['kind'])} thumbs={thumbs}>
        {sum.text}
      </StepSummary>
      {!open && <GroupLiveLink items={items} />}
      <Collapse open={open}>
        <div className="step-list">
          {runs.map((r) =>
            r.kind === 'control' ? (
              <ControlRun key={keys.get(r.steps[0])} steps={r.steps} cwd={cwd} />
            ) : (
              <StepRow key={keys.get(r.step)} step={r.step} cwd={cwd} />
            ),
          )}
        </div>
      </Collapse>
    </div>
  );
}

/**
 * The running group's line. In the Claude look it is Claude Desktop's running group row: the working mark, what the
 * step in progress does (between steps, the last step's words with the thinking mark; "Thinking…" before the first),
 * the clock, opening to the group's finished steps and thoughts, then the running command's live output. In the Codex
 * look: the step in progress, its live output on request, the last step, or "Thinking".
 */
function RunningLine({
  items,
  steps,
  listed,
  cwd,
  ux,
  elapsedMs,
  hideTime,
  thoughts,
}: {
  items: DisplayItem[];
  steps: Step[];
  /** the group's finished steps and its thoughts, as the open row lists them */
  listed: Step[];
  cwd: string;
  ux: ActivityUx;
  elapsedMs: number | null;
  hideTime: boolean;
  thoughts: ThoughtDisclosures;
}) {
  const showReasoning = useStore((s) => s.prefs.showReasoning);
  const [liveOpenId, setLiveOpenId] = useState<string | null>(null);
  const { open, toggle } = thoughts.group;
  // the command whose live output the open row shows: the one running when it was opened, so the next does not open by itself
  const [liveShownId, setLiveShownId] = useState<string | null>(null);
  const timing = useTurnTiming();
  // Keep reasoning available while the current activity changes below it.
  const cur = currentStep(steps);
  // a wait has no status: it is over when its item ended
  const waitOver = cur?.kind === 'wait' && timing.timeOf(cur.item.id)?.end != null;
  const currentRunning =
    !!cur &&
    !waitOver &&
    !((cur.item as WithStatus).status && (cur.item as WithStatus).status !== 'inProgress' && cur.kind !== 'reasoning');
  const showing = currentRunning && cur && cur.kind !== 'reasoning' ? cur : undefined;
  const held = heldStep(steps);
  // a wait counts down on its own clock: the agent page's group has no turn clock to redraw it
  const now = useNow(currentRunning && cur?.kind === 'wait');
  // Output arriving must not open a panel or move the conversation. Live output is opt-in,
  // and opening one command does not open the next command in the group.
  const live = showing?.kind === 'command' ? showing.item : null;
  // each label stays up a moment, so a run of quick tools does not flicker (Claude Desktop's 650 ms)
  const words = useMinDwell(held ? heldWords(held, timing, now) : '', undefined, ROW_DWELL);
  const chatId = useContext(AgentChatContext);
  const slotted = !!useStatusSlot() && !hideTime;
  if (ux === 'dots') {
    // Once a tool finishes, the turn waits on the model again, including before a reasoning item arrives: the mark
    // says so, while the words stay on the last step.
    const thinking = !currentRunning || cur?.kind === 'reasoning';
    const keys = stepKeys(listed);
    const opens = listed.length > 0 || !!live;
    const activity = markActivity(cur, !!currentRunning);
    const line = (
      <ClaudeActivity
        row
        label={words || undefined}
        activity={activity}
        thinking={thinking}
        elapsedMs={hideTime ? null : elapsedMs}
        trailing={
          <>
            <GroupLiveLink items={items} />
            {slotted && <InlineCounts chatId={chatId} />}
          </>
        }
        open={open}
        onToggle={
          opens
            ? () => {
                setLiveShownId(open ? null : (live?.id ?? null));
                toggle();
              }
            : undefined
        }
      >
        {opens ? (
          <div className="step-list">
            {listed.map((step) => (
              <StepRow
                key={keys.get(step)}
                step={step}
                cwd={cwd}
                running={step.kind === 'reasoning' && thoughtItems(step).some((t) => t === cur?.item)}
                disclosure={step.kind === 'reasoning' ? thoughts.of(step) : undefined}
              />
            ))}
            {live && live.id === liveShownId && <ShellBox cmd={prettyCommand(live.command)} output={live.aggregatedOutput} live />}
          </div>
        ) : null}
      </ClaudeActivity>
    );
    // Move the row rather than copying it: the active group and the waiting placeholder share this one location.
    return slotted ? <InStatusSlot>{line}</InStatusSlot> : line;
  }
  if (live)
    return (
      <RunningCommand
        id={live.id}
        expandedId={liveOpenId}
        onExpand={setLiveOpenId}
        icon={stepIcon('command', (showing as { network?: boolean }).network)}
        label={
          <>
            <Shimmer>{activeStepLabel(cur, showReasoning)}</Shimmer>
            {!hideTime && <ActivityTime elapsedMs={elapsedMs} />}
          </>
        }
      >
        <ShellBox cmd={prettyCommand(live.command)} output={live.aggregatedOutput} live />
      </RunningCommand>
    );
  const named = currentRunning ? cur : held;
  return (
    <>
      <div className="step-row active">
        {showing ? (
          <span className="step-icon">{stepIcon(showing.kind, (showing as { network?: boolean }).network)}</span>
        ) : (
          // nothing concrete to report yet: the status vocabulary's thinking glyph, not a step icon
          <ThinkingDots />
        )}
        <Shimmer>{named?.kind === 'wait' ? heldWords(named, timing, now) : activeStepLabel(named, showReasoning)}</Shimmer>
        {!hideTime && <ActivityTime elapsedMs={elapsedMs} />}
        {/* a command sent to the background earlier in the running group still offers its output */}
        <GroupLiveLink items={items} />
      </div>
    </>
  );
}

/**
 * Consecutive browser or desktop control as one row that says what it did, as Claude Desktop's group row does
 * ("Clicked, waited, captured page", "…, and 2 more actions, 1 failed"; a run in one app ends "in <icon> Notes"), with
 * its latest screenshots; open, a strip of every screenshot in order and each step's own row (its raw call one more
 * click away), so the run can be replayed step by step.
 */
export function ControlRun({ steps, cwd }: { steps: Step[]; cwd: string }) {
  const [open, setOpen] = useState(false);
  const control = steps.filter((s) => stepControl(s));
  const surfaces = new Set(control.map((s) => stepControl(s)!.surface));
  // one desktop app reads as that app, its icon first ("Used Notes"); Claude Desktop's "Used your computer" otherwise
  useAppNamesVersion();
  const apps = [...new Set(control.flatMap((s) => stepControl(s)!.app ?? []))];
  const one = surfaces.size === 1 && surfaces.has('desktop') && apps.length === 1 ? apps[0] : null;
  const icon = one ? appIcon(one) : null;
  const inApp = one ? appLabel(one) : null;
  const keys = stepKeys(steps);
  const frames = control.flatMap((s) => {
    const src = controlThumbnail(s.item);
    return src ? [{ src, label: stepControl(s)!.done, key: keys.get(s) }] : [];
  });
  const thumbs = controlShots(control);
  return (
    <div className={`step step-group control-run ${open ? 'open' : ''}`}>
      <StepSummary
        open={open}
        onToggle={() => setOpen((o) => !o)}
        icon={surfaces.has('browser') ? stepIcon('web') : <MousePointerClick size={16} strokeWidth={1.6} />}
        thumbs={thumbs}
      >
        {controlWords(control, inApp)}
        {/* one app: "… in <icon> Notes" (Claude Design option 2A names the app with its icon) */}
        {one && (
          <>
            {' '}
            in {icon && <img className="step-app-icon" src={icon} alt="" />}
            {inApp}
          </>
        )}
      </StepSummary>
      <Collapse open={open}>
        {frames.length > 1 && (
          <div className="control-filmstrip" aria-label="Screenshots in order">
            {frames.map((f, i) => (
              <ZoomableImage
                key={f.key}
                className="control-frame"
                src={f.src}
                alt={`Step ${i + 1}: ${f.label}`}
                title={`${i + 1}. ${f.label}`}
              />
            ))}
          </div>
        )}
        <div className="step-list">
          {steps.map((s) => (
            <StepRow key={keys.get(s)} step={s} cwd={cwd} inApp={inApp} />
          ))}
        </div>
      </Collapse>
    </div>
  );
}
