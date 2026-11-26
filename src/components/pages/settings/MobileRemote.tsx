// Settings → Connections → Phone: the local opt-in and the paired phones; adding one opens Connect your phone, as every other entry does.
import { useEffect, useRef, useState } from 'react';
import { native } from '../../../lib/native';
import { imeComposing } from '../../../lib/focus';
import { noteIgnored, userError } from '../../../lib/ignored';
import { openConnectPhone } from '../../../lib/phoneEntry';
import type { RemoteSettingsState } from '../../../lib/native/remoteSettings';
import type { ReactNode } from 'react';
import { RefreshCw } from '../../ui/icons';
import { Tooltip } from '../../ui/Popover';
import { ConsequenceConfirm } from './ConsequenceConfirm';
import { AddDeviceDialog } from './AddDeviceDialog';
import { WEAK_KEY_TEXT } from './AllowSheet';
import { useFlag } from '../../../lib/flags';
import { Group, Row, Toggle } from './Controls';
import { phoneLine } from './phoneSeen';
import { REFUSAL_TEXT } from '../../../../shared/remote/relayRefusal.mjs';
import { phoneSummary } from '../../../../shared/phoneConnections.mjs';

/**
 * Control this Mac: the one switch and the one list of devices that may control it. The phones are here; `extra` is more rows of the same list (the ChatGPT devices of Codex's Remote Control)
 * and `extraVisible` says there are some to show even where phones are not offered.
 */
export function MobileRemote({
  extra = null,
  extraVisible = false,
  linkOn = false,
  alsoOff,
  otherSwitch = false,
  weakKey = false,
}: {
  extra?: ReactNode;
  extraVisible?: boolean;
  /** another kind of control (Codex's Remote Control) is on: the switch reads on, and turning it off turns that off too */
  linkOn?: boolean;
  alsoOff?: () => unknown;
  /** the other kind of control has its own switch under Other settings, so a signed-out user is told it still works */
  otherSwitch?: boolean;
  /** this Mac's own approval key for pairing by code is in software (no Secure Enclave): said once, under the switch */
  weakKey?: boolean;
} = {}) {
  const [state, setState] = useState<RemoteSettingsState | null>(null);
  const [error, setError] = useState('');
  // why the last read failed: it goes with the next read that works, which a change's own error does not
  const [readFailure, setReadFailure] = useState('');
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const codePair = useFlag('host.codePair');
  const [choosing, setChoosing] = useState(false);
  const [asking, setAsking] = useState<{ title: string; lines: string[]; action: string; run: () => void } | null>(null);
  const revision = useRef(0);
  const mounted = useRef(false);
  useEffect(() => {
    let active = true;
    mounted.current = true;
    let timer: ReturnType<typeof setTimeout>;
    const read = async () => {
      const mine = ++revision.current;
      try {
        const next = await native.remoteSettings.state();
        if (active && mine === revision.current) {
          setState(next);
          setReadFailure('');
        }
      } catch (e) {
        if (active && mine === revision.current) setReadFailure(userError(e));
      }
      if (active) timer = setTimeout(read, 1000);
    };
    void read();
    return () => {
      active = false;
      mounted.current = false;
      revision.current++;
      clearTimeout(timer);
    };
  }, []);
  const phones = state?.visible === true;
  // the ChatGPT rows stay while the phones' state cannot be read: the read's error shows with them, not instead of them
  if (!phones && !extraVisible && !(readFailure && !state)) return null;
  /** Runs a change and reads the state again; true when the change worked. */
  const action = async (work: () => Promise<unknown>) => {
    ++revision.current;
    try {
      setError('');
      await work();
      const mine = ++revision.current;
      const next = await native.remoteSettings.state();
      if (mounted.current && mine === revision.current) setState(next);
      return true;
    } catch (e) {
      if (mounted.current) setError(userError(e));
      // a change that got halfway (phones off, the ChatGPT link still on) shows as it is, so the switch can be tried again
      try {
        const next = await native.remoteSettings.state();
        if (mounted.current) setState(next);
      } catch (readError) {
        noteIgnored('read the phone settings after a failed change', readError);
      }
      return false;
    }
  };
  /** Add a phone: with only the other kind of control on, the phones are turned on first and nothing else is torn down. */
  const addPhone = () =>
    state?.visible && state.enabled
      ? openConnectPhone()
      : void action(() => native.remoteSettings.setEnabled(true)).then((ok) => ok && openConnectPhone());
  const stale = 'This phone connection changed. Check paired devices and try again.';
  const saveName = (device: { id: string; pairId: string }) =>
    action(async () => {
      if (!(await native.remoteSettings.rename(device.id, device.pairId, draft))) throw new Error(stale);
      setEditing(null);
    });
  return (
    <Group
      title="Devices that can control this Mac"
      desc={
        phones && state.enabled
          ? state.running && !state.locked
            ? `${phoneSummary(state.devices)}. Pairings stay saved when a phone goes offline or MoPilot restarts.`
            : 'Phone access is starting or unavailable. Saved pairings have not been checked.'
          : undefined
      }
      action={
        phones && (
          <div className="settings-group-actions">
            <Tooltip label="Refresh">
              <button type="button" className="icon-btn xs" aria-label="Refresh" onClick={() => action(async () => undefined)}>
                <RefreshCw size={14} />
              </button>
            </Tooltip>
            {(state.enabled || linkOn) && !state.locked && state.signedIn && (
              <button
                type="button"
                className="btn-pill primary"
                // with only the other kind of control on, adding a phone turns the phones on first: nothing else is torn down
                onClick={() => (codePair ? setChoosing(true) : addPhone())}
              >
                Add
              </button>
            )}
          </div>
        )
      }
    >
      {phones && (
        <Row
          title="Allow connections"
          desc={
            state.consentWarning ? (
              <span role="alert">Couldn't save this setting. It may come back after a restart.</span>
            ) : !state.signedIn ? (
              otherSwitch ? (
                'Sign in to MoPilot to connect a phone. Other devices have their own switch under Other settings.'
              ) : (
                'Sign in to MoPilot to connect a phone.'
              )
            ) : state.enabled && state.refusal ? (
              // why the relay is turning this Mac away, on the switch's own row (no row of its own)
              <span role="alert">Phones can't reach this Mac right now. {REFUSAL_TEXT[state.refusal]}</span>
            ) : (
              <>
                Phones and other devices can connect to this Mac and run your chats. SSH access is separate.
                {weakKey && <span className="settings-row-note"> {WEAK_KEY_TEXT}</span>}
              </>
            )
          }
        >
          <Toggle
            label="Allow connections"
            on={state.enabled || linkOn}
            disabled={!state.signedIn}
            onChange={(on) =>
              on
                ? action(() => native.remoteSettings.setEnabled(true))
                : setAsking({
                    title: 'Turn off connections?',
                    lines: [
                      'Phones and other devices connected now are disconnected, and nothing can connect until you turn it on again.',
                      'Paired devices stay saved.',
                    ],
                    action: 'Turn off',
                    run: () => void action(async () => (await native.remoteSettings.setEnabled(false), await alsoOff?.())),
                  })
            }
          />
        </Row>
      )}
      {phones && state.enabled && state.locked && (
        <Row title="Phone storage needs recovery" desc="Restart MoPilot, then check your paired phones." />
      )}
      {phones &&
        state.enabled &&
        state.devices.map((device) => (
          <Row
            key={device.id}
            title={
              editing === device.id ? (
                <input
                  className="text-input slim"
                  aria-label={`Name for ${device.name}`}
                  autoFocus
                  maxLength={60}
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (imeComposing(e)) return;
                    if (e.key === 'Enter' && draft.trim()) void saveName(device);
                    if (e.key === 'Escape') {
                      // this field's Escape, not the Settings page's
                      e.stopPropagation();
                      setEditing(null);
                    }
                  }}
                />
              ) : (
                device.name
              )
            }
            desc={
              device.retired ? (
                'Disconnected. Revoke its access to take it off this Mac.'
              ) : (
                <span title={device.lastSeenAt === null ? undefined : new Date(device.lastSeenAt).toLocaleString()}>
                  {phoneLine(device, Date.now())}
                </span>
              )
            }
          >
            {!device.retired && editing === device.id && (
              <>
                <button type="button" className="btn-pill soft" onClick={() => setEditing(null)}>
                  Cancel
                </button>
                <button type="button" className="btn-pill" disabled={!draft.trim()} onClick={() => saveName(device)}>
                  Save
                </button>
              </>
            )}
            {!device.retired && editing !== device.id && (
              <>
                <button
                  type="button"
                  className="btn-pill soft"
                  onClick={() => {
                    setDraft(device.name);
                    setEditing(device.id);
                  }}
                >
                  Rename
                </button>
                <span className="settings-row-desc">Terminal and screen</span>
                <Toggle
                  label={`Terminal and screen for ${device.name}`}
                  on={device.mirrors}
                  onChange={() =>
                    action(async () => {
                      if (!(await native.remoteSettings.setMirrors(device.id, device.pairId, !device.mirrors))) throw new Error(stale);
                    })
                  }
                />
              </>
            )}
            <button
              type="button"
              className="btn-pill danger"
              aria-label={`Revoke access for ${device.name}`}
              onClick={() =>
                setAsking({
                  title: `Revoke access for ${device.name}?`,
                  lines: ['It is disconnected now, and it must be paired again to control this Mac.'],
                  action: 'Revoke access',
                  run: () =>
                    void action(async () => {
                      if (!(await native.remoteSettings.revoke(device.id, device.pairId))) throw new Error(stale);
                    }),
                })
              }
            >
              Revoke access
            </button>
          </Row>
        ))}
      {extra}
      {choosing && <AddDeviceDialog onPhone={addPhone} onClose={() => setChoosing(false)} />}
      {asking && (
        <ConsequenceConfirm
          {...asking}
          onCancel={() => setAsking(null)}
          onConfirm={() => {
            asking.run();
            setAsking(null);
          }}
        />
      )}
      {(error || readFailure) && <Row title={<span role="alert">{error || readFailure}</span>} />}
    </Group>
  );
}
