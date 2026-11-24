// Settings → Connections → Control this Mac: Codex's Remote Control, the link that lets the user's other devices reach this computer
// (the summary panel's Session section has the quick switch): its devices are rows of the one device list, its switch and code are in Other settings.
import { useState } from 'react';
import { useStore } from '../../../store/core';
import { codexUsable } from '../../../store/chats';
import {
  revokeRemoteControlClient,
  setCodexRemoteControl,
  useCodexRemoteControl,
  useRemoteControlClients,
  useRemoteControlPairing,
  type CodexRemoteControlClient,
  type CodexRemoteControlView,
} from '../../../session/harness/codexRemoteControl';
import { codexFailure, codexReconnecting } from '../../../session/harness/codexRemoteControlText';
import { relativeTime } from '../../../lib/format';
import { toast } from '../../../store/core';
import { imeComposing } from '../../../lib/focus';
import { RemoteControlConfirm } from '../../panels/RemoteControlConfirm';
import { ConsequenceConfirm } from './ConsequenceConfirm';
import { Row, Toggle } from './Controls';

/** What the switch's row says for each state of the link. */
function describe(view: CodexRemoteControlView | null) {
  if (view?.retrying) return codexReconnecting(view);
  if (view?.status === 'connecting') return 'Connecting…';
  if (view?.status === 'connected') return 'Authorized devices on your ChatGPT account can discover and control this computer';
  return (view && codexFailure(view)) || 'Let your other devices discover and control this computer';
}

const clientLine = (c: CodexRemoteControlClient) =>
  [c.platform, c.lastSeenAt ? `Last connected ${relativeTime(c.lastSeenAt)}` : null].filter(Boolean).join(' · ') || 'Authorized device';

/** The code a device types to pair with this computer, until one does or it ends. */
function PairingDialog({ onClose, onAdded }: { onClose: () => void; onAdded: () => void }) {
  const { pairing, restart } = useRemoteControlPairing(() => {
    toast('Device added');
    onAdded();
    onClose();
  });
  const minutes =
    pairing.phase === 'ready' ? `${Math.floor(pairing.secondsLeft / 60)}:${String(pairing.secondsLeft % 60).padStart(2, '0')}` : '';
  return (
    <div className="sketch-backdrop" onKeyDown={(e) => e.key === 'Escape' && !imeComposing(e) && onClose()}>
      <div className="dialog acct-dialog" role="dialog" aria-label="Add a device">
        <div className="dialog-head">
          <span>Add a device</span>
        </div>
        <div className="acct-dialog-hint">
          <p>Enter this code in ChatGPT on the device you want to connect.</p>
          {pairing.phase === 'loading' && <p>Getting a code…</p>}
          {pairing.phase === 'ready' && (
            <p>
              <strong aria-label="Pairing code" style={{ fontSize: 'var(--fs-title)', letterSpacing: '0.08em' }}>
                {pairing.code}
              </strong>
              <br />
              Expires in {minutes}
            </p>
          )}
          {pairing.phase === 'expired' && <p>The code expired.</p>}
          {pairing.phase === 'error' && <p>{pairing.message}</p>}
        </div>
        <div className="acct-dialog-actions">
          {/* focus starts inside the dialog, so Escape reaches it */}
          <button className="btn sm" autoFocus onClick={onClose}>
            Close
          </button>
          <span style={{ flex: 1 }} />
          {(pairing.phase === 'expired' || pairing.phase === 'error') && (
            <button className="btn primary sm" autoFocus onClick={restart}>
              {pairing.phase === 'expired' ? 'New code' : 'Try again'}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

/** Turns Codex's Remote Control off (the one Allow connections switch does it with the phones). */
export const codexLinkOff = () => setCodexRemoteControl(false);

/** Codex's Remote Control as the tab reads it: whether it is offered (Codex usable), its link, and the devices on it. */
export function useCodexControl() {
  const usable = useStore((s) => codexUsable(s));
  const view = useCodexRemoteControl(usable);
  const connected = view?.status === 'connected';
  const { clients, error, refresh } = useRemoteControlClients(connected);
  return { usable, view, connected, clients, error, refresh };
}
export type CodexControl = ReturnType<typeof useCodexControl>;

/** The ChatGPT devices that may control this computer, as rows of the one device list: each with when it last connected and Revoke access. */
export function CodexClientRows({ control }: { control: CodexControl }) {
  const { connected, clients, error, refresh } = control;
  const [revoking, setRevoking] = useState<string | null>(null);
  const [asking, setAsking] = useState<{ id: string; name: string } | null>(null);
  const revoke = async (id: string) => {
    setRevoking(id);
    if (await revokeRemoteControlClient(id)) toast('Revoked device access');
    setRevoking(null);
    refresh();
  };
  if (!connected) return null;
  return (
    <>
      {error && (
        <Row title="Couldn't load the devices" desc={error}>
          <button className="btn-pill soft" onClick={refresh}>
            Retry
          </button>
        </Row>
      )}
      {!error && clients?.length === 0 && <Row title="No devices added yet" desc="Add a device to control this computer from it" />}
      {!error &&
        clients?.map((c) => (
          <Row key={c.clientId} title={c.name ?? 'Device'} desc={clientLine(c)}>
            <button
              className="btn-pill soft"
              disabled={revoking === c.clientId}
              aria-label={`Revoke access for ${c.name ?? 'Device'}`}
              onClick={() => setAsking({ id: c.clientId, name: c.name ?? 'This device' })}
            >
              Revoke access
            </button>
          </Row>
        ))}
      {asking && (
        <ConsequenceConfirm
          title={`Revoke access for ${asking.name}?`}
          lines={['It is disconnected now, and it must be added again to control this computer.']}
          action="Revoke access"
          onCancel={() => setAsking(null)}
          onConfirm={() => {
            void revoke(asking.id);
            setAsking(null);
          }}
        />
      )}
    </>
  );
}

/** Codex's own switch for being controlled from ChatGPT, with the code to add a device; shown only where Codex is usable. */
export function CodexSwitchRows({ control }: { control: CodexControl }) {
  const { usable, view, connected, refresh } = control;
  const [confirming, setConfirming] = useState(false);
  const [pairing, setPairing] = useState(false);
  if (!usable) return null;
  return (
    <>
      <Row title="Allow this computer to be controlled" desc={describe(view)}>
        <Toggle
          on={view?.status === 'connecting' || view?.retrying === true || connected}
          disabled={!view}
          label="Allow this computer to be controlled"
          onChange={(next) => (next ? setConfirming(true) : setCodexRemoteControl(false))}
        />
      </Row>
      {connected && (
        <Row title="Add a ChatGPT device">
          <button className="btn-pill soft" onClick={() => setPairing(true)}>
            Add
          </button>
        </Row>
      )}
      {confirming && (
        <RemoteControlConfirm
          onCancel={() => setConfirming(false)}
          onAllow={() => {
            setConfirming(false);
            void setCodexRemoteControl(true);
          }}
        />
      )}
      {pairing && <PairingDialog onClose={() => setPairing(false)} onAdded={refresh} />}
    </>
  );
}
