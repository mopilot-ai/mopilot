// Settings › MoMo › Brain › Audit log (#2290, #2292): the audit log's state with Export audit log, and Start a new log when it can't go on; when MoMo's remembered approvals can't be read, the choice to set them aside and start empty; and the sites MoMo may open after reading private data ("Always allow <host>" on its card, #3655), each with Remove. Everything goes through main (electron/app/ipc/momoTrust.cjs), which refuses while MoMo is off; the state is read again after each change.
import { useCallback, useEffect, useRef, useState } from 'react';
import { native } from '../../../lib/native';
import type { MomoTrustStatus } from '../../../lib/native/momoTrust';
import { errorText } from '../../../lib/ignored';
import { toast } from '../../../store/core';
import { Group, Row } from '../../pages/settings/Controls';

type Action = 'export' | 'startOver' | 'setAside' | 'removeSite';

/** What the Audit log row says for the log's state. */
export function auditDesc(s: MomoTrustStatus['audit'] | null, failed: string | null): string {
  if (failed) return failed;
  if (!s) return 'Checking…';
  if (s.state === 'ok') return 'Every action MoMo took, kept on this Mac.';
  return s.reason;
}

export function TrustRecordsSettings() {
  const [status, setStatus] = useState<MomoTrustStatus | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [busy, setBusy] = useState<Action | null>(null);
  const alive = useRef(true);
  const read = useCallback(async () => {
    try {
      const s = await native.momoTrust.status();
      if (!alive.current) return;
      setStatus(s);
      setFailed(null);
    } catch (e) {
      if (!alive.current) return;
      // nothing is offered on a state that couldn't be read
      setStatus(null);
      setFailed(errorText(e));
    }
  }, []);
  useEffect(() => {
    alive.current = true;
    void read();
    return () => {
      alive.current = false;
    };
  }, [read]);
  /** One action at a time (every button is disabled while one runs); its outcome told, and the state read again after it. */
  const run = async (action: Action, fn: () => Promise<string | null>) => {
    setBusy(action);
    try {
      const said = await fn();
      if (said) toast(said);
    } catch (e) {
      toast(errorText(e), 'error');
    }
    if (!alive.current) return;
    setBusy(null);
    await read();
  };
  const audit = status?.audit ?? null;
  const sites = status?.sites ?? [];
  return (
    <>
      <Group title="Audit log">
        <Row title="Audit log" desc={auditDesc(audit, failed)}>
          {(audit?.state === 'ok' || (audit?.state === 'stuck' && audit.exportable)) && (
            <button
              className="btn-pill"
              disabled={busy !== null}
              onClick={() =>
                void run('export', async () => {
                  const { saved } = await native.momoTrust.exportAudit();
                  return saved && `Saved ${saved}`;
                })
              }
            >
              {busy === 'export' ? 'Exporting…' : 'Export audit log'}
            </button>
          )}
          {audit?.state === 'stuck' && (
            <button
              className="btn-pill"
              disabled={busy !== null}
              onClick={() =>
                void run('startOver', async () => {
                  await native.momoTrust.startOverAudit();
                  return 'Started a new log. The old one was kept.';
                })
              }
            >
              {busy === 'startOver' ? 'Starting…' : 'Start a new log'}
            </button>
          )}
        </Row>
        {status?.approvals.state === 'unavailable' && <Row title="Remembered approvals" desc={status.approvals.reason} />}
        {status?.approvals.state === 'unreadable' && (
          <Row title="Remembered approvals" desc="They can't be read. Set them aside to start empty.">
            <button
              className="btn-pill"
              disabled={busy !== null}
              onClick={() =>
                void run('setAside', async () => {
                  await native.momoTrust.setAsideApprovals();
                  return 'Set aside. MoMo asks again from now on.';
                })
              }
            >
              {busy === 'setAside' ? 'Setting aside…' : 'Set aside'}
            </button>
          </Row>
        )}
      </Group>
      {sites.length > 0 && (
        <Group
          title="Sites MoMo may open"
          desc="After reading your private data, MoMo opens these without asking. Anything else still asks."
        >
          {sites.map((host) => (
            <Row key={host} title={host}>
              <button
                className="btn-pill"
                disabled={busy !== null}
                onClick={() =>
                  void run('removeSite', async () => {
                    await native.momoTrust.removeSite(host);
                    return `Removed ${host}`;
                  })
                }
              >
                Remove
              </button>
            </Row>
          ))}
        </Group>
      )}
    </>
  );
}
