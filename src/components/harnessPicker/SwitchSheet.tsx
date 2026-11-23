// Confirm a harness switch with its timing and only the choices that apply to this chat.
// Nothing happens until the next message is sent; the lines come from src/harness/switchPlan.ts.
import { useId, useState } from 'react';
import { useStore } from '../../store/core';
import { useSession } from '../../store/session/useSession';
import { HARNESS_LABEL, type HarnessId, type HarnessModel, type PendingSwitch } from '../../harness/types';
import { harnessInfo } from '../../harness/registry';
import { switchAccountLabel, useChatAccount, useEffectiveSelection, useHarnessAccounts } from '../../session/harness/select';
import { canCarryMultiAgent, defaultContinueGoal, multiAgentIsOn, sheetPlan, userQueued } from '../../harness/switchPlan';
import { useControllerChanges } from '../../harness/controllerChanges';
import { HarnessIcon } from './HarnessPicker';
import { useQuickSwitch } from './quickSwitch';

/** What the user chose in the sheet. */
export interface SwitchChoices {
  mode: PendingSwitch['mode'];
  /** the goal's condition to set again on the new segment, or null */
  goal: string | null;
  multiAgent: boolean;
  queued: 'send' | 'leave';
  /** the effort the target model starts at (the mapping the Changes column shows) */
  effort: string | null;
}

export const MODES: { id: PendingSwitch['mode']; label: string; desc: string }[] = [
  {
    id: 'auto',
    label: 'Automatic (recommended)',
    desc: 'Carries the conversation verbatim when it fits; older turns are condensed when it doesn’t.',
  },
  {
    id: 'summary',
    label: 'Summary',
    desc: 'The current harness writes a handoff note from its full context, in a fork. Takes about half a minute.',
  },
  { id: 'workspace', label: 'Workspace only', desc: 'No conversation, just the folder, branch and git changes. For a fresh look.' },
];

export function SwitchSheet({
  threadId,
  from,
  target,
  model,
  account,
  ask = false,
  onCancel,
  onConfirm,
}: {
  threadId: string;
  from: HarnessId;
  target: HarnessId;
  model: HarnessModel;
  /**
   * Opened from an account row: the account picked for the chat on the target, or null for Automatic (clears the
   * chat's pin there). Undefined: opened from a model, the chat's own there applies.
   */
  account?: string | null;
  /** show the sheet even with nothing at risk (the switch chip's Options) */
  ask?: boolean;
  onCancel: () => void;
  onConfirm: (c: SwitchChoices) => void;
}) {
  const session = useSession(threadId);
  const permission = useStore((s) => s.prefs.permission);
  const segments = useStore((s) => s.segments[threadId]);
  const source = useEffectiveSelection(from, threadId);
  const ownThere = useChatAccount(target, threadId);
  const targetAccounts = useHarnessAccounts(target);
  const accountName = switchAccountLabel(account, ownThere, targetAccounts, account === null);
  // the account is named when an account was picked, or the chat has its own there: otherwise it is the
  // harness's account in use, as for any chat
  const ownAccount = account !== undefined || !!ownThere?.pinned;
  const [mode, setMode] = useState<PendingSwitch['mode']>('auto');
  // each sheet's radios are their own groups, even with two sheets open in two chats
  const group = useId();
  const modeGroup = `${group}mode`;
  const [more, setMore] = useState(false);
  const [continueGoal, setContinueGoal] = useState(defaultContinueGoal(from, target));
  const [multiAgent, setMultiAgent] = useState(false);
  const [queued, setQueued] = useState<'send' | 'leave'>('send');
  // who controls the in-app browser, the computer and the user's Chrome after the switch, where that changes
  const controls = useControllerChanges(threadId, target);

  // a chat going back to a harness resumes its session there, so it has no handoff to choose
  const back = segments?.some((x) => x.harness === target);
  const multiAgentOn = multiAgentIsOn(from, source.effort, !!session.ultracode?.on);
  const carryMultiAgent = canCarryMultiAgent(target, model.efforts);
  const plan = sheetPlan({
    from,
    to: target,
    fromLabel: HARNESS_LABEL[from],
    toLabel: HARNESS_LABEL[target],
    vendor: harnessInfo(target)?.vendor ?? HARNESS_LABEL[target],
    // no account known at all (signed out there): the harness is named
    account: accountName ?? HARNESS_LABEL[target],
    goal: session.goal ? { objective: session.goal.objective, status: session.goal.status } : null,
    effortFrom: source.effort === 'ultra' ? null : source.effort,
    targetEfforts: model.efforts,
    targetDefaultEffort: model.defaultEffort,
    permission,
    targetAutoMode: model.autoMode,
    multiAgentOn,
    queued: userQueued(session.queue).length,
  });
  const confirm = () =>
    onConfirm({
      mode,
      goal: plan.goal && continueGoal && session.goal ? session.goal.objective : null,
      multiAgent: multiAgentOn && multiAgent && carryMultiAgent,
      queued,
      effort: plan.effort.to,
    });
  // nothing at risk: one click switches (the chip above the composer offers Undo)
  const quiet = !plan.goal && !plan.queued && plan.permission.to === permission && !multiAgentOn && !controls.length && !ownAccount;
  if (useQuickSwitch(quiet && !ask, confirm)) return null;

  return (
    <div className="menu switch-sheet">
      <h5>
        <HarnessIcon h={target} size={16} /> Continue on {HARNESS_LABEL[target]} · {model.label}
      </h5>
      <p>
        Applies to your next message.{' '}
        {mode === 'workspace' ? 'Only your workspace carries over.' : 'Your conversation and workspace carry over.'}
      </p>
      {/* the effort carries over (mapped to the nearest level the target has): said up front, not silently;
          a model without effort levels has none to name */}
      {/* the account the chat goes on and where its data goes (design/multi-account rule 4) */}
      {ownAccount && <div className="ss-line">{plan.account}</div>}
      {plan.effort.to && <div className="ss-line">{plan.effort.text}</div>}
      {plan.permission.to !== permission && <div className="ss-line">{plan.permission.text}</div>}
      {controls.map((line) => (
        <div key={line} className="ss-line">
          {line}
        </div>
      ))}
      {plan.goal && (
        <label className="ss-choice">
          <input type="checkbox" checked={continueGoal} onChange={(e) => setContinueGoal(e.target.checked)} /> Continue the current goal
        </label>
      )}
      {multiAgentOn && carryMultiAgent && (
        <label className="ss-choice">
          <input type="checkbox" checked={multiAgent} onChange={(e) => setMultiAgent(e.target.checked)} /> Keep multiple agents on
        </label>
      )}
      {multiAgentOn && !carryMultiAgent && <div className="ss-line">Multiple agents will turn off.</div>}
      {plan.queued && (
        <div className="ss-line">
          {plan.queued.text}
          <label className="ss-choice">
            <input type="radio" name={`${group}queued`} checked={queued === 'send'} onChange={() => setQueued('send')} /> Send after
            switching
          </label>
          <label className="ss-choice">
            <input type="radio" name={`${group}queued`} checked={queued === 'leave'} onChange={() => setQueued('leave')} /> Leave them here
          </label>
        </div>
      )}
      {!back &&
        (more ? (
          MODES.map((o) => (
            <label key={o.id} className={`ss-opt ${o.id === mode ? 'on' : ''}`}>
              {/* a native radio drawn as the sheet's dot: Tab reaches the group and the arrows pick */}
              <input type="radio" className="ss-radio" name={modeGroup} checked={o.id === mode} onChange={() => setMode(o.id)} />
              <span>
                <b>{o.label}</b>
                <br />
                <span className="ss-desc">{o.desc}</span>
              </span>
            </label>
          ))
        ) : (
          <button className="ss-more" onClick={() => setMore(true)}>
            More options
          </button>
        ))}
      <div className="ss-privacy">This conversation will be sent to {harnessInfo(target)?.vendor}.</div>
      <div className="ss-foot">
        <button className="btn ghost sm" onClick={onCancel}>
          Cancel
        </button>
        <button className="btn primary sm" onClick={confirm}>
          Switch
        </button>
      </div>
    </div>
  );
}
