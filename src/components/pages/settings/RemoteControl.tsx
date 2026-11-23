// Settings → Connections → Control from ChatGPT: Codex's Remote Control, the link that lets the user's other devices reach this computer
// (the summary panel's Session section has the quick switch), with the devices paired and a code to pair another.
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
import { Group, Row, Toggle } from './Controls';

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

export function ControlThisComputer() {
  const usable = useStore((s) => codexUsable(s));
  const view = useCodexRemoteControl(usable);
  const connected = view?.status === 'connected';
  const { clients, error, refresh } = useRemoteControlClients(connected);
  const [confirming, setConfirming] = useState(false);
  const [pairing, setPairing] = useState(false);
  const [revoking, setRevoking] = useState<string | null>(null);
  if (!usable) return null;
  const revoke = async (id: string) => {
    setRevoking(id);
    if (await revokeRemoteControlClient(id)) toast('Revoked device access');
    setRevoking(null);
    refresh();
  };
  return (
    <Group title="Control from ChatGPT">
      <Row title="Allow this computer to be controlled" desc={describe(view)}>
        <Toggle
          on={view?.status === 'connecting' || view?.retrying === true || connected}
          disabled={!view}
          label="Allow this computer to be controlled"
          onChange={(next) => (next ? setConfirming(true) : setCodexRemoteControl(false))}
        />
      </Row>
      {connected && (
        <Row title="Devices that can control this computer">
          <button className="btn-pill soft" onClick={() => setPairing(true)}>
            Add
          </button>
        </Row>
      )}
      {connected && error && (
        <Row title="Couldn't load the devices" desc={error}>
          <button className="btn-pill soft" onClick={refresh}>
            Retry
          </button>
        </Row>
      )}
      {connected && !error && clients?.length === 0 && (
        <Row title="No devices added yet" desc="Add a device to control this computer from it" />
      )}
      {connected &&
        clients?.map((c) => (
          <Row key={c.clientId} title={c.name ?? 'Device'} desc={clientLine(c)}>
            <button className="btn-pill soft" disabled={revoking === c.clientId} onClick={() => revoke(c.clientId)}>
              Revoke access
            </button>
          </Row>
        ))}
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
    </Group>
  );
}
