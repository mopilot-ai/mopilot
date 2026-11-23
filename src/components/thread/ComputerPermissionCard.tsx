// The card asking for the macOS permissions desktop control needs (Accessibility, Screen Recording, Input Monitoring).

import { useRef, useState } from 'react';
import { useEffectOn } from '../../lib/effects';
import { native, type ComputerPermission } from '../../lib/native';
import { copy } from '../../harness/copy';
import { chatHarnessLabel } from '../../store/chats';
import { MousePointerClick, Check } from '../ui/icons';
import { errorText, noteIgnored } from '../../lib/ignored';
import { TRY_AGAIN } from '../../lib/uiLabels';

const TEXT = {
  accessibility: 'permissionAccessibility',
  screenRecording: 'permissionScreenRecording',
  inputMonitoring: 'permissionInputMonitoring',
} as const;

/** The macOS permissions desktop control needs, in the order the card lists them. */
const ROWS: { id: ComputerPermission; label: string; why: string }[] = [
  { id: 'accessibility', label: 'Accessibility', why: 'to click and type, and so Esc stops it' },
  { id: 'screenRecording', label: 'Screen Recording', why: 'to see the apps it works in' },
  { id: 'inputMonitoring', label: 'Input Monitoring', why: 'so moving the mouse takes over' },
];
const LABEL = Object.fromEntries(ROWS.map((r) => [r.id, r.label])) as Record<ComputerPermission, string>;

/** The rows the card shows: Accessibility and Screen Recording always, Input Monitoring when it is the one missing. */
export function permissionRows(missing: ComputerPermission) {
  return ROWS.filter((r) => r.id !== 'inputMonitoring' || missing === 'inputMonitoring');
}

/**
 * Shown in the chat (the status strip) when desktop control failed for a missing macOS permission, in
 * place of a bare tool error: each permission it needs with its state and a deep link to its System
 * Settings pane, and Try again, which looks again (the card goes away once nothing is missing). The
 * state comes from main (desktop.cjs / computerUse raise it), so any harness's call shows the same card.
 */
export function ComputerPermissionCard({ threadId, permission }: { threadId: string; permission: ComputerPermission }) {
  return <PermissionCard key={JSON.stringify([threadId, permission])} threadId={threadId} permission={permission} />;
}

function PermissionCard({ threadId, permission }: { threadId: string; permission: ComputerPermission }) {
  const harness = chatHarnessLabel(threadId);
  const [granted, setGranted] = useState<Partial<Record<ComputerPermission, boolean>> | null>(null);
  const [busy, setBusy] = useState(false);
  // why Request or Try again failed: the card stays (main raised it and takes it down), saying so
  const [error, setError] = useState<string | null>(null);
  // the permission main still reported missing when Request or Try again finished: macOS may show no prompt
  // (a stale grant for an older helper build), so while the newest status reads it off the card says so and
  // what to do next. Not after a failed read: an unread permission is not called off
  const [stillOff, setStillOff] = useState<ComputerPermission | null>(null);
  // A card belongs to one chat and missing permission; every effect setup owns its reads and actions.
  const owner = useRef<{ active: boolean; read: () => Promise<void> } | null>(null);
  useEffectOn([], () => {
    let reads = 0;
    const own = {
      active: true,
      async read() {
        if (!own.active) return;
        const read = ++reads;
        try {
          const status = await native.computer.status();
          if (own.active && read === reads) setGranted(status.permissions ?? null);
        } catch (error) {
          if (own.active && read === reads) throw error;
        }
      },
    };
    owner.current = own;
    const load = () => own.read().catch((e) => noteIgnored('read the desktop control permissions for the permission card', e));
    void load();
    const off = native.computer.onChanged?.(load);
    return () => {
      own.active = false;
      off?.();
    };
  });
  /** `fn` answers main's recheck: true when nothing is missing now. */
  const run = async (fn: (current: () => boolean) => Promise<boolean>) => {
    // The effect installs the owner before a person can act on the mounted card.
    const own = owner.current!;
    const current = () => own.active;
    setBusy(true);
    setError(null);
    setStillOff(null);
    try {
      const ok = await fn(current);
      if (!current()) return;
      await own.read();
      if (current() && !ok) setStillOff(permission);
    } catch (e) {
      if (current()) setError(errorText(e));
    } finally {
      if (current()) setBusy(false);
    }
  };
  const tryAgain = () => run(() => native.computer.recheck(threadId));
  return (
    <div className="cu-guide cu-permission cu-onboarding" role="alert" data-permission={permission}>
      <span className="cu-guide-icon">
        <MousePointerClick size={18} strokeWidth={1.6} />
      </span>
      <div className="cu-guide-text">
        <div>{copy('computerUse', TEXT[permission], { Harness: harness })}</div>
        <ul className="cu-onboarding-rows">
          {permissionRows(permission).map((r) => {
            const ok = granted?.[r.id] === true && r.id !== permission;
            return (
              <li key={r.id} data-granted={ok ? 'true' : 'false'}>
                <span className="cu-onboarding-state">{ok ? <Check size={13} /> : <span className="cu-onboarding-dot" />}</span>
                <span className="cu-onboarding-label">
                  <b>{r.label}</b> {r.why}
                </span>
                {!ok && r.id === permission && (
                  <button
                    className="btn-pill soft"
                    disabled={busy}
                    onClick={(e) =>
                      e.nativeEvent.isTrusted &&
                      void run(async (current) => {
                        // on only when macOS answered on and main's look again finds nothing missing
                        const on = await native.computer.requestPermission(r.id);
                        if (!current()) return false;
                        return (await native.computer.recheck(threadId)) && on;
                      })
                    }
                  >
                    Request
                  </button>
                )}
                {!ok && (
                  <button className="btn-pill soft" onClick={(e) => e.nativeEvent.isTrusted && native.computer.openSettings(r.id)}>
                    {copy('computerUse', 'openSystemSettings')}
                  </button>
                )}
              </li>
            );
          })}
        </ul>
        {stillOff === permission && granted?.[permission] === false && (
          <div className="cu-permission-still" role="status">
            {copy('computerUse', 'permissionStillOff', { Permission: LABEL[permission] })}
          </div>
        )}
        {error && <div className="config-warning">Couldn't check the permissions: {error}</div>}
      </div>
      <button className="btn-pill" disabled={busy} onClick={(e) => e.nativeEvent.isTrusted && void tryAgain()}>
        {TRY_AGAIN}
      </button>
    </div>
  );
}
