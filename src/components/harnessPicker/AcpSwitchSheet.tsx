// In-place handoff confirmation whenever either side uses ACP, with only supported transfer choices.
import { useId, useState } from 'react';
import { useSession } from '../../store/session/useSession';
import { chatKind } from '../../store/chats';
import { isFirstTier, type HarnessKind } from '../../harness/adapter';
import { harnessInfo } from '../../harness/registry';
import { basicLabel } from '../../session/harness/acp';
import { HARNESS_LABEL, type PendingSwitch } from '../../harness/types';
import { useControllerChanges } from '../../harness/controllerChanges';
import { userQueued } from '../../harness/switchPlan';
import { MODES, type SwitchChoices } from './SwitchSheet';
import { BasicBadge, HarnessIcon } from './HarnessPicker';
import { useQuickSwitch } from './quickSwitch';

export const switchTargetLabel = (kind: HarnessKind) => (isFirstTier(kind) ? HARNESS_LABEL[kind] : basicLabel(kind.slice(4)));

export function AcpSwitchSheet({
  threadId,
  target,
  ask = false,
  onCancel,
  onConfirm,
}: {
  threadId: string;
  target: HarnessKind;
  /** show the sheet even with nothing at risk (the switch chip's Options) */
  ask?: boolean;
  onCancel: () => void;
  onConfirm: (choices: SwitchChoices) => void;
}) {
  const [mode, setMode] = useState<PendingSwitch['mode']>('auto');
  const [more, setMore] = useState(false);
  const [queued, setQueued] = useState<'send' | 'leave'>('send');
  const group = useId();
  const session = useSession(threadId);
  const controls = useControllerChanges(threadId, target);
  const summary = isFirstTier(chatKind(threadId));
  const label = switchTargetLabel(target);
  const basic = isFirstTier(target) ? null : target.slice(4);
  const confirm = () => onConfirm({ mode, queued, goal: null, multiAgent: false, effort: null });
  // nothing at risk: one click switches (the chip above the composer offers Undo)
  const goal = !!session.goal && session.goal.status !== 'complete';
  if (useQuickSwitch(!ask && !controls.length && !goal && !userQueued(session.queue).length, confirm)) return null;
  return (
    <div className="menu switch-sheet">
      <h5>
        <HarnessIcon h={target} size={16} /> Continue on {label} {basic && <BasicBadge id={basic} />}
      </h5>
      <p>Applies to your next message. Your conversation and workspace stay in this chat.</p>
      {controls.map((line) => (
        <div key={line} className="ss-line">
          {line}
        </div>
      ))}
      {session.goal && session.goal.status !== 'complete' && (
        <div className="ss-line">The current goal stays paused on its original harness.</div>
      )}
      {userQueued(session.queue).length > 0 && (
        <div className="ss-line">
          {userQueued(session.queue).length} queued messages
          {(['send', 'leave'] as const).map((value) => (
            <label key={value} className="ss-choice">
              <input type="radio" name={`${group}queue`} checked={queued === value} onChange={() => setQueued(value)} />
              {value === 'send' ? 'Send after switching' : 'Leave them here'}
            </label>
          ))}
        </div>
      )}
      {more ? (
        MODES.filter((o) => summary || o.id !== 'summary').map((o) => (
          <label key={o.id} className={`ss-opt ${mode === o.id ? 'on' : ''}`}>
            <input type="radio" className="ss-radio" name={`${group}mode`} checked={mode === o.id} onChange={() => setMode(o.id)} />
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
      )}
      {!summary && more && <div className="ss-line">Automatic carries the conversation without changing the original session.</div>}
      <div className="ss-privacy">
        {mode === 'workspace' ? 'Workspace details' : 'This conversation'} will be sent to {harnessInfo(target)?.vendor ?? label}.
      </div>
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
