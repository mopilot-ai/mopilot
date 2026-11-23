// A step group with agent launches, as Claude Desktop's tool-group card: a live morphing header and one row per agent that opens its page.
import { useContext, useMemo, useRef, useState } from 'react';
import { agentGroupSummary, agentRunOf, agentRunningLabel, agentVerb, type AgentRun } from '../../lib/agentRun';
import { LABEL_DWELL_MS, useMinDwell } from '../../lib/minDwell';
import { reasoningText, visibleSteps } from '../../lib/reasoning';
import { useStore } from '../../store/core';
import { openAgentPage } from '../../store/panes';
import { MorphText } from '../ui/MorphText';
import { ChevronRight } from '../ui/icons';
import { ActivityTime } from '../thread/ActivityTime';
import { ClaudeActivity } from '../thread/ClaudeActivity';
import { InStatusSlot, useStatusSlot } from '../thread/statusSlot';
import { InlineCounts } from '../tasks/SessionsCount';
import { claudeActivityLabel } from '../../session/activityUx';
import { markActivity } from '../../session/activityWords';
import { activeStepLabel, Shimmer } from '../thread/items/presentation';
import {
  itemSteps,
  mergeThoughts,
  narrateSteps,
  summarizeSteps,
  thoughtItems,
  type DisplayItem,
  type Step,
} from '../thread/items/stepModel';
import type { ThoughtDisclosures } from '../thread/items/StepGroups';
import { GroupLiveLink, StepRow } from '../thread/items/StepRow';
import { AgentChatContext } from './AgentChatContext';
import type { NarrationContext } from '../../lib/agentNarration';

/** The MoPilot chat whose transcript (or agent page) is rendering, so agent rows can open their page. */
export { AgentChatContext } from './AgentChatContext';

const SETTLED = 'settled';
const HOLD = { restKey: SETTLED, fallHoldMs: LABEL_DWELL_MS };

type Row = { kind: 'agent'; run: AgentRun; item: DisplayItem } | { kind: 'step'; step: Step; key: string };

/** Whether a step group holds an agent launch (and so renders as an agent group). */
export const hasAgentRun = (items: DisplayItem[]) => items.some((i) => agentRunOf(i) !== null);

const inProgress = (s: Step) => (s.item as { status?: string | null }).status === 'inProgress';

export function AgentGroup({
  items,
  cwd,
  active,
  elapsedMs = null,
  hideTime = false,
  disclosures,
  narration,
}: {
  items: DisplayItem[];
  cwd: string;
  active: boolean;
  /** the turn's elapsed time, which the running header carries as the single shimmering line used to */
  elapsedMs?: number | null;
  /** A standalone agent page has no turn status to move into its containing chat. */
  hideTime?: boolean;
  /** Shared with plain steps so switching to an agent group retains the user's open thoughts. */
  disclosures: ThoughtDisclosures;
  /** the app bindings Codex's computer-use programs left before this group */
  narration?: NarrationContext;
}) {
  const chatId = useContext(AgentChatContext);
  const inThread = useStatusSlot() !== undefined && !hideTime;
  const slotted = inThread && active;
  const showReasoning = useStore((s) => s.prefs.showReasoning);
  // thoughts before the first step read as the dim italic lines above the card
  const lead = items.findIndex((i) => i.type !== 'reasoning');
  const thoughts = showReasoning
    ? items
        .slice(0, lead)
        .map((i) => ({ id: i.id, text: reasoningText(i).trim() }))
        .filter((t) => t.text)
    : [];
  const rows = useMemo(() => {
    const body = slotted ? items : items.slice(lead);
    const raw: Row[] = body.flatMap((item): Row[] => {
      const run = agentRunOf(item);
      if (run) return [{ kind: 'agent', run, item }];
      // an item can read as several steps: its id, then how many of its steps came before, keep each row's identity
      let nth = 0;
      return itemSteps(item).map((step) => ({ kind: 'step', step, key: `${item.id}:${nth++}` }));
    });
    // browser and desktop narration is worked out over the whole group, in order
    const narrated = narrateSteps(
      raw.flatMap((r) => (r.kind === 'step' ? [r.step] : [])),
      body,
      narration,
    );
    let at = 0;
    return raw.map((r): Row => (r.kind === 'step' ? { kind: 'step', step: narrated[at++], key: r.key } : r));
  }, [items, lead, narration, slotted]);
  const runs = rows.flatMap((r) => (r.kind === 'agent' ? [r.run] : []));
  const steps = rows.flatMap((r) => (r.kind === 'step' ? [r.step] : []));
  const visible = visibleSteps(steps, showReasoning);
  const anyRunning = runs.some((r) => r.status === 'running' && (active || !inThread || r.background));
  // the header follows the first running agent in group order, else the step running now
  const runningRun = runs.find((r) => r.status === 'running' && (active || !inThread || r.background));
  const runningStep = !runningRun && active ? [...steps].reverse().find((s) => inProgress(s) && s.kind !== 'reasoning') : undefined;
  const target = runningRun ? `agent:${runningRun.key}` : runningStep ? `step:${runningStep.item.id}` : SETTLED;
  const held = useMinDwell(target, LABEL_DWELL_MS, HOLD);
  const find = (k: string) => ({ run: runs.find((r) => `agent:${r.key}` === k), step: steps.find((s) => `step:${s.item.id}` === k) });
  let shown = held;
  let cur = find(held);
  // the held label names a row that left the group: show the live one
  if (held !== SETTLED && !cur.run && !cur.step) cur = find((shown = target));
  // the summary freezes while the title is mid-transition
  const summary = agentGroupSummary(runs, summarizeSteps(visible).text);
  const frozen = useRef(summary);
  if (shown === target) frozen.current = summary;

  const [mounted, setMounted] = useState(anyRunning && !slotted);
  // the dwell holds the label, not the running line: once nothing in the group runs and the turn has moved past it (the
  // reply streams, the waiting line shows in the status slot), the header stops being a running line at once, so the turn
  // never draws two (tests/e2e/agent-group-one-line.spec.ts)
  const live = shown !== SETTLED && (active || anyRunning);
  // the card opens for running agents; the header folds it at any time, live or not, and the user's choice stays (as Claude Desktop)
  const [open, setOpen] = useState(anyRunning && !slotted);
  // a command is named as the status line names it: its program, never words that could carry a credential
  const stepLabel = (step: Step) => (step.kind === 'command' ? claudeActivityLabel(step) : String(activeStepLabel(step, showReasoning)));
  const label = cur.run ? agentRunningLabel(cur.run) : cur.step ? stepLabel(cur.step) : frozen.current;
  const rowOpen = slotted ? disclosures.group.open : open;

  // consecutive thoughts in the card read as one row, as in a step group
  const shownRows = mergeThoughts(
    rows.filter((r) => r.kind === 'agent' || visible.includes(r.step)),
    (r) => (r.kind === 'step' ? r.step : null),
    // only a step row carries a thought, so only a step row is merged into
    (r, step) => ({ ...r, step }) as Row,
  );
  const thoughtRows = !slotted && thoughts.length > 0 && (
    <div className="agent-group-thoughts">
      {thoughts.map((t) => (
        <div key={t.id} className="agent-group-thought">
          {t.text}
        </div>
      ))}
    </div>
  );
  const card = (
    <div className="agent-card" hidden={!rowOpen}>
      {shownRows.map((r) =>
        r.kind === 'agent' ? (
          <AgentRow key={r.run.key} run={r.run} chatId={chatId} />
        ) : (
          <div key={r.key} className="agent-card-cell">
            <StepRow
              step={r.step}
              cwd={cwd}
              running={slotted && r.step.kind === 'reasoning' && thoughtItems(r.step).some((item) => item === items.at(-1))}
              disclosure={slotted && r.step.kind === 'reasoning' ? disclosures.of(r.step) : undefined}
            />
          </div>
        ),
      )}
    </div>
  );
  if (slotted)
    return (
      <InStatusSlot>
        <ClaudeActivity
          row
          label={live ? label : undefined}
          activity={cur.run ? 'default' : markActivity(cur.step, live)}
          thinking={!live}
          elapsedMs={elapsedMs}
          trailing={
            <>
              {!rowOpen && <GroupLiveLink items={items} />}
              <InlineCounts chatId={chatId} />
            </>
          }
          open={rowOpen}
          onToggle={disclosures.group.toggle}
        >
          {thoughtRows}
          {card}
        </ClaudeActivity>
      </InStatusSlot>
    );
  return (
    <div className="agent-group">
      {thoughtRows}
      <div className="agent-group-main">
        <button
          className={`agent-group-head ${live ? 'running' : open ? 'open' : ''}`}
          aria-expanded={open}
          onClick={() => {
            setMounted(true);
            setOpen((o) => !o);
          }}
        >
          <MorphText morphKey={shown} className="agent-group-title">
            {live ? <Shimmer>{label}</Shimmer> : label}
          </MorphText>
          {live && active && elapsedMs !== null && <ActivityTime elapsedMs={elapsedMs} />}
          <ChevronRight size={14} className="agent-group-chevron" aria-hidden />
        </button>
        {/* the running-tasks count rides on the turn's one running line, beside the header's clock */}
        {live && active && elapsedMs !== null && <InlineCounts chatId={chatId} />}
        {!open && <GroupLiveLink items={items} />}
        {(open || mounted) && card}
      </div>
      {/* Claude Desktop's one running line: once the group settles while the turn runs, the model thinks again on a row
          under it, with the clock; nothing goes in the status slot under the task list. An untimed view (an agent's
          page) draws neither, as no turn of its own runs there */}
      {active && !live && elapsedMs !== null && (
        <ClaudeActivity row activity="think" thinking elapsedMs={elapsedMs} trailing={<InlineCounts chatId={chatId} />} />
      )}
    </div>
  );
}

/** One agent in the card: dim verb, the description, and a caret once it settles; a click opens its page. */
export function AgentRow({ run, chatId }: { run: AgentRun; chatId: string }) {
  const status = useMinDwell(run.status, LABEL_DWELL_MS, undefined, run.key);
  const running = status === 'running';
  const verb = agentVerb(status);
  return (
    <button className={`agent-row agent-card-cell ${status}`} onClick={() => openAgentPage(chatId, run.key, run.description)}>
      <MorphText morphKey={verb} className="agent-row-verb">
        {running ? <Shimmer>{verb}</Shimmer> : <span className="agent-row-verb-text">{verb}</span>}
      </MorphText>
      <span className="agent-row-desc">{run.description}</span>
      {status === 'stopped' && <span className="agent-row-outcome">Stopped</span>}
      {!running && <ChevronRight size={16} className="agent-row-caret" aria-hidden />}
    </button>
  );
}
