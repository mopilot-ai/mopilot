// Settings → Connections → Phone: the local opt-in and the paired phones; adding one opens Connect your phone, as every other entry does.
import { useEffect, useRef, useState } from 'react';
import { native } from '../../../lib/native';
import { imeComposing } from '../../../lib/focus';
import { userError } from '../../../lib/ignored';
import { openConnectPhone } from '../../../lib/phoneEntry';
import type { RemoteSettingsState } from '../../../lib/native/remoteSettings';
import { Group, Row, Toggle } from './Controls';
import { phoneLine } from './phoneSeen';
import { REFUSAL_TEXT } from '../../../../shared/remote/relayRefusal.mjs';
import { phoneSummary } from '../../../../shared/phoneConnections.mjs';

export function MobileRemote() {
  const [state, setState] = useState<RemoteSettingsState | null>(null);
  const [error, setError] = useState('');
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
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
        if (active && mine === revision.current) setState(next);
      } catch (e) {
        if (active && mine === revision.current) setError(userError(e));
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
  if (!state?.visible) return null;
  const action = async (work: () => Promise<unknown>) => {
    ++revision.current;
    try {
      setError('');
      await work();
      const mine = ++revision.current;
      const next = await native.remoteSettings.state();
      if (mounted.current && mine === revision.current) setState(next);
    } catch (e) {
      if (mounted.current) setError(userError(e));
    }
  };
  const stale = 'This phone connection changed. Check paired devices and try again.';
  const saveName = (device: { id: string; pairId: string }) =>
    action(async () => {
      if (!(await native.remoteSettings.rename(device.id, device.pairId, draft))) throw new Error(stale);
      setEditing(null);
    });
  const paired = state.devices.some((device) => !device.retired);
  return (
    <Group
      title="Phone"
      desc={
        state.enabled
          ? state.running && !state.locked
            ? `${phoneSummary(state.devices)}. Pairings stay saved when a phone goes offline or MoPilot restarts.`
            : 'Phone access is starting or unavailable. Saved pairings have not been checked.'
          : undefined
      }
    >
      <Row
        title="Allow phone access"
        desc={
          state.consentWarning ? (
            <span role="alert">Couldn't save this setting. It may come back after a restart.</span>
          ) : !state.signedIn ? (
            'Sign in to MoPilot to connect a phone.'
          ) : state.enabled && state.refusal ? (
            // why the relay is turning this Mac away, on the switch's own row (no row of its own)
            <span role="alert">Phones can't reach this Mac right now. {REFUSAL_TEXT[state.refusal]}</span>
          ) : undefined
        }
      >
        <Toggle
          label="Allow phone access"
          on={state.enabled}
          disabled={!state.signedIn}
          onChange={(on) => action(() => native.remoteSettings.setEnabled(on))}
        />
      </Row>
      {state.enabled && state.locked && <Row title="Phone storage needs recovery" desc="Restart MoPilot, then check your paired phones." />}
      {state.enabled &&
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
                'Disconnected. Remove it from this Mac.'
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
              onClick={() =>
                action(async () => {
                  if (!(await native.remoteSettings.revoke(device.id, device.pairId))) throw new Error(stale);
                })
              }
            >
              Remove
            </button>
          </Row>
        ))}
      {state.enabled && !state.locked && (
        <Row title={paired ? 'Add another phone' : 'Connect your phone'}>
          <button type="button" className="btn-pill soft" onClick={openConnectPhone}>
            {paired ? 'Add' : 'Connect'}
          </button>
        </Row>
      )}
      {error && <Row title={<span role="alert">{error}</span>} />}
    </Group>
  );
}
