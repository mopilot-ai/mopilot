// The Switch host dialog behind the host chip: pick a machine that can take the chat, name a folder on it, and see every refusal as a reason in place. The chat stays where it was until the continue succeeds; the composer's draft is never read or cleared here.
import { useEffect, useId, useRef, useState } from 'react';
import { busyField, isEnter, imeComposing } from '../../lib/focus';
import { native } from '../../lib/native';
import { hostContinue } from '../../lib/hostContinue';
import { noteIgnored } from '../../lib/ignored';
import { machineReason } from '../../lib/hostNote';
import { HostFolderPicker } from './HostFolderPicker';
import { SwitchHostFix } from './SwitchHostFix';
import { HostUpdateAction } from '../host/HostUpdateAction';
import { userError } from '../../../shared/userError.mjs';
import {
  lastDirectory,
  fixFor,
  refusalCopy,
  refusalMachine,
  rememberDirectory,
  targetsFor,
  WAIT_FOR_MESSAGE,
  type SwitchMachine,
  type SwitchTarget,
} from '../../lib/hostSwitch';

/** What the dialog asks main to continue; `lostHostConfirmed` is the user's yes to continuing without the unreachable source. */
export type ContinueRequest = {
  chatId: string;
  targetHostId: string;
  cwd: string;
  lostHostConfirmed: boolean;
  /** the source's uncommitted changes go with the chat; new files only when `confirmed` and listed */
  carry?: { confirmed: boolean; untracked: string[]; unpushed: number };
};
/** What carrying the chat's uncommitted changes would send: new files (not ignored), files never sent because their names look like secrets, how many files changed (`changed` names the first ones git already knew; a Host from before it names none), and the commits origin lacks that the push publishes with them (`unpushed`, to `remote`). */
export type CarryPlan = { untracked: string[]; changed?: string[]; skipped: string[]; files: number; unpushed: number; remote: string };
/** How many new files the dialog lists before it says "and N more". */
const LISTED = 8;

type Phase = 'form' | 'confirm' | 'carry' | 'busy';

export function SwitchHostDialog({
  chatId,
  project,
  ownerId,
  ownerLost,
  machines,
  initialTarget = null,
  turnRunning,
  queued = false,
  agent,
  onContinue,
  onPlan,
  onClose,
}: {
  chatId: string;
  /** the chat's project folder: the last folder used on each machine is remembered per project */
  project: string;
  ownerId: string;
  /** the chat's host cannot be reached: it is listed as a target again, and continuing asks first */
  ownerLost: boolean;
  machines: SwitchMachine[];
  /** the machine picked when the dialog opens (its row in the host menu was clicked); null: the first one that can take the chat */
  initialTarget?: string | null;
  turnRunning: boolean;
  /** a message is on its way to the chat's host or waits behind a turn */
  queued?: boolean;
  /** the agent the chat runs on (its id: claude, codex or an ACP agent), so a machine that cannot take it says why on its row */
  agent?: string;
  onContinue: (req: ContinueRequest) => Promise<unknown>;
  /** what carrying the chat's uncommitted changes to the folder would send (null: nothing); absent: the chat goes without asking */
  onPlan?: (req: { chatId: string; targetHostId: string; cwd: string }) => Promise<{ plan: CarryPlan | null } | null>;
  onClose: () => void;
}) {
  const label = useId();
  // closed or cancelled before its continue started: what the dialog held for the move is released (a continue that did start has taken it over)
  useEffect(
    () => () =>
      void Promise.resolve()
        .then(() => hostContinue.release(chatId))
        .catch((e) => noteIgnored('release what the Switch host dialog held', e)),
    [chatId],
  );
  const box = useRef<HTMLDivElement>(null);
  // Escape reaches the backdrop only from inside it: keyboard focus starts in the dialog (unless a field there has it) and comes back when the folder picker closes
  const browsingNow = useRef(false);
  useEffect(() => {
    if (!browsingNow.current && !box.current?.contains(document.activeElement)) box.current?.focus();
  });
  const targets = targetsFor(machines, ownerId, ownerLost, agent);
  const [picked, setPicked] = useState<string | null>(initialTarget);
  // folders the user typed, per machine; a machine without one starts at its last used folder for this project
  const [typed, setTyped] = useState<Record<string, string>>({});
  const [phase, setPhase] = useState<Phase>('form');
  const [error, setError] = useState<string | null>(null);
  // the code of the last refusal and its machine: a machine the app read as ready that the press found not ready still gets its fix
  const [refused, setRefused] = useState<{ code?: string; hostId: string } | null>(null);
  // the machine whose folders are being browsed, over this dialog
  // the changes the user is asked about, and the lost-host yes that came before
  const [asked, setAsked] = useState<{ plan: CarryPlan; confirmed: boolean } | null>(null);
  const [browsing, setBrowsing] = useState<SwitchTarget | null>(null);
  const target = targets.find((t) => t.id === (picked ?? targets.find((x) => !x.reason)?.id));
  const dir = target ? (typed[target.id] ?? lastDirectory(project, target.id)) : '';
  const owner = machines.find((m) => m.id === ownerId)?.name ?? ownerId;
  const blocked = turnRunning
    ? 'Stop the running turn first.'
    : queued
      ? `${WAIT_FOR_MESSAGE}.`
      : !target || target.reason
        ? 'Pick a host.'
        : !dir.trim()
          ? `Choose a folder on ${target.name}.`
          : null;

  /** This Mac has no Host to ask for folders: its own folder picker answers; a remote machine lists its folders in the picker over the dialog. */
  async function browse(t: SwitchTarget) {
    if (t.id !== 'local') return setBrowsing(t);
    const path = await native.dialog.openFolder();
    if (path) setTyped((all) => ({ ...all, [t.id]: path }));
  }

  /** What a refusal says in place; the form (or the carry question) stays as it was. */
  function refuse(e: unknown, t: SwitchTarget, back: Phase) {
    const code = (e as { code?: string })?.code;
    setError(refusalCopy(code, refusalMachine(code, t.name, owner), userError(e, { fallback: "Couldn't switch host." }), agent));
    setRefused({ code, hostId: t.id });
    setPhase(back);
  }

  /** Continues the chat, with its changes when the user chose to carry them. */
  async function finish(t: SwitchTarget, confirmed: boolean, carry?: ContinueRequest['carry']) {
    setPhase('busy');
    setError(null);
    setRefused(null);
    try {
      await onContinue({ chatId, targetHostId: t.id, cwd: dir.trim(), lostHostConfirmed: confirmed, ...(carry && { carry }) });
    } catch (e) {
      // what was typed stays, so the user fixes the one thing the refusal names
      return refuse(e, t, carry ? 'carry' : 'form');
    }
    rememberDirectory(project, t.id, dir.trim());
    onClose();
  }

  /** Asks what carrying the changes would send first; with nothing to carry the chat goes at once. */
  async function run(t: SwitchTarget, confirmed: boolean) {
    setPhase('busy');
    setError(null);
    setRefused(null);
    let plan: CarryPlan | null | undefined;
    try {
      plan = (await onPlan?.({ chatId, targetHostId: t.id, cwd: dir.trim() }))?.plan;
    } catch (e) {
      return refuse(e, t, 'form');
    }
    if (!plan) return finish(t, confirmed);
    setAsked({ plan, confirmed });
    setPhase('carry');
  }

  const busy = phase === 'busy';
  // a machine that did not answer or went offline: the same press asks it again, said as what it does
  const retry = !!error && (refused?.code === 'host_unreachable' || refused?.code === 'target_offline');
  // the files git already knew that the carry sends: the plan names the first ones, and the count of all files says how many there are in all
  const changed = asked?.plan.changed ?? [];
  const changedTotal = asked ? Math.max(asked.plan.files - asked.plan.untracked.length, changed.length) : 0;
  const send = target && !blocked ? (confirmed: boolean) => void run(target, confirmed) : null;
  // continuing without an unreachable source asks first
  const go = send && (ownerLost ? () => setPhase('confirm') : () => send(false));
  return (
    <div className="sketch-backdrop" onKeyDown={(e) => e.key === 'Escape' && !imeComposing(e) && !busy && !browsing && onClose()}>
      <div ref={box} tabIndex={-1} className="dialog acct-dialog switch-host" role="dialog" aria-modal="true" aria-labelledby={label}>
        <div className="dialog-head">
          <span id={label}>Switch host</span>
        </div>
        {phase === 'carry' && asked && target ? (
          <>
            <p className="acct-dialog-hint">
              {asked.plan.files === 1 ? '1 file has' : `${asked.plan.files} files have`} uncommitted changes. Carry{' '}
              {asked.plan.files === 1 ? 'it' : 'them'} to {target.name}?
            </p>
            {changed.length > 0 && (
              <div className="switch-host-files">
                <p className="acct-dialog-hint">Changed files that would be sent:</p>
                <ul aria-label="Changed files">
                  {changed.slice(0, LISTED).map((f) => (
                    <li key={f}>{f}</li>
                  ))}
                </ul>
                {changedTotal > Math.min(changed.length, LISTED) && (
                  <p className="acct-dialog-hint">and {changedTotal - Math.min(changed.length, LISTED)} more</p>
                )}
              </div>
            )}
            {asked.plan.untracked.length > 0 && (
              <div className="switch-host-files">
                <p className="acct-dialog-hint">New files that would be sent:</p>
                <ul aria-label="New files">
                  {asked.plan.untracked.slice(0, LISTED).map((f) => (
                    <li key={f}>{f}</li>
                  ))}
                </ul>
                {asked.plan.untracked.length > LISTED && (
                  <p className="acct-dialog-hint">and {asked.plan.untracked.length - LISTED} more</p>
                )}
              </div>
            )}
            {asked.plan.skipped.length > 0 && (
              <p className="acct-dialog-hint">Never sent, the names look like secrets: {asked.plan.skipped.join(', ')}</p>
            )}
            {asked.plan.unpushed > 0 && (
              <p className="acct-dialog-hint">
                {asked.plan.unpushed === 1 ? '1 unpushed commit' : `${asked.plan.unpushed} unpushed commits`} will be pushed to{' '}
                {asked.plan.remote || 'origin'} with the changes.
              </p>
            )}
            {error && (
              <p className="acct-dialog-hint" role="alert">
                {error}
                <HostUpdateAction hostId={refused?.hostId} text={error} />
              </p>
            )}
            <div className="acct-dialog-actions">
              <button className="btn sm" onClick={() => setPhase('form')}>
                Back
              </button>
              <span style={{ flex: 1 }} />
              <button className="btn sm" onClick={() => void finish(target, asked.confirmed)}>
                Continue without changes
              </button>
              <button
                className="btn primary sm"
                autoFocus
                onClick={() =>
                  void finish(target, asked.confirmed, { confirmed: true, untracked: asked.plan.untracked, unpushed: asked.plan.unpushed })
                }
              >
                Carry changes
              </button>
            </div>
          </>
        ) : phase === 'confirm' ? (
          <>
            <p className="acct-dialog-hint">
              {owner} isn't reachable. Continue on {target?.name ?? 'the host'} from this Mac's copy of the chat? Anything {owner} hasn't
              sent yet is left out.
            </p>
            <div className="acct-dialog-actions">
              <button className="btn sm" onClick={() => setPhase('form')}>
                Back
              </button>
              <span style={{ flex: 1 }} />
              <button className="btn primary sm" autoFocus disabled={!send} onClick={() => send?.(true)}>
                Continue anyway
              </button>
            </div>
          </>
        ) : (
          <>
            {targets.length === 0 ? (
              <p className="acct-dialog-hint">No other host.</p>
            ) : (
              <div className="switch-host-list" role="radiogroup" aria-label="Host">
                {targets.map((t) => (
                  <button
                    key={t.id}
                    role="radio"
                    aria-checked={t.id === target?.id}
                    className="switch-host-row"
                    disabled={!!t.reason || busy}
                    title={t.reason ?? undefined}
                    onClick={() => setPicked(t.id)}
                  >
                    <span className={`host-dot ${t.status}`} aria-hidden="true" />
                    <span className="switch-host-name">{t.name}</span>
                    <span className="switch-host-note">{t.reason ?? machineReason(t.note, t.agents)}</span>
                  </button>
                ))}
              </div>
            )}
            {target && (
              <div className="switch-host-dir">
                <input
                  className="text-input"
                  aria-label="Folder on the host"
                  autoFocus
                  placeholder={`Folder on ${target.name}`}
                  value={dir}
                  {...busyField(busy)}
                  onChange={(e) => setTyped((all) => ({ ...all, [target.id]: e.target.value }))}
                  onKeyDown={(e) => isEnter(e) && !busy && go?.()}
                />
                <button className="btn sm" disabled={busy} onClick={() => browse(target)}>
                  Browse…
                </button>
              </div>
            )}
            {targets.flatMap((t) => {
              const fix = fixFor(t, agent, refused?.hostId === t.id ? refused.code : undefined);
              return fix
                ? [
                    <SwitchHostFix
                      key={t.id}
                      fix={fix}
                      onDone={() => {
                        // the machine is read again as its row changes; the press checks it once more
                        setError(null);
                        setRefused(null);
                        setPicked(t.id);
                      }}
                    />,
                  ]
                : [];
            })}
            {(error || blocked) && (
              <p className="acct-dialog-hint" role={error ? 'alert' : undefined}>
                {error ?? blocked}
                {error && <HostUpdateAction hostId={refused?.hostId} text={error} />}
              </p>
            )}
            <div className="acct-dialog-actions">
              <button className="btn sm" disabled={busy} onClick={onClose}>
                Cancel
              </button>
              <span style={{ flex: 1 }} />
              <button className="btn primary sm" disabled={!go || busy} onClick={() => go?.()}>
                {busy ? 'Switching…' : retry ? 'Try again' : 'Switch host'}
              </button>
            </div>
          </>
        )}
      </div>
      {browsing && (
        <HostFolderPicker
          hostId={browsing.id}
          name={browsing.name}
          onClose={() => setBrowsing(null)}
          onPick={(path) => {
            setTyped((all) => ({ ...all, [browsing.id]: path }));
            setBrowsing(null);
          }}
        />
      )}
    </div>
  );
}
