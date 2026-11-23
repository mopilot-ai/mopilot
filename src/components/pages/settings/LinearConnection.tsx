// Settings → Connections → Linear: the user's own Linear personal API key, kept encrypted in main (electron/platform/linearSource.cjs) and shown only as its last four characters, so a chat can start from a Linear issue.

import { useEffect, useState } from 'react';
import { Group, Row } from './Controls';
import { native } from '../../../lib/native';
import { errorText } from '../../../lib/ignored';
import { isEnter } from '../../../lib/focus';
import { toast } from '../../../store/core';

export function LinearConnection() {
  const [status, setStatus] = useState<{ connected: boolean; last4: string | null } | null>(null);
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let live = true;
    native.linear.status().then(
      (s) => live && setStatus(s),
      (e) => live && toast(`Couldn't read the Linear connection: ${errorText(e)}`, 'error'),
    );
    return () => {
      live = false;
    };
  }, []);
  if (!status) return null;
  const connect = async () => {
    if (busy || !key.trim()) return;
    setBusy(true);
    try {
      const r = await native.linear.connect(key.trim());
      if (!r.ok) return void toast(r.error, 'error');
      setKey('');
      setStatus(await native.linear.status());
      toast(r.name ? `Connected to Linear as ${r.name}` : 'Connected to Linear', 'success');
    } catch (e) {
      toast(`Couldn't connect Linear: ${errorText(e)}`, 'error');
    } finally {
      setBusy(false);
    }
  };
  const disconnect = async () => {
    try {
      await native.linear.disconnect();
      setStatus(await native.linear.status());
    } catch (e) {
      toast(`Couldn't disconnect Linear: ${errorText(e)}`, 'error');
    }
  };
  return (
    <Group title="Linear">
      {status.connected ? (
        <Row
          title="Linear"
          desc={`Connected with the API key ending in ${status.last4}. Type an issue's key, like ENG-12, in a new chat's branch search.`}
        >
          <button className="btn sm" onClick={disconnect}>
            Disconnect
          </button>
        </Row>
      ) : (
        <Row
          title="Linear"
          desc="Start a chat from a Linear issue. Paste a personal API key from Linear (in Linear’s own settings, under Security & access, Personal API keys); it is kept encrypted on this Mac."
        >
          <input
            className="text-input slim"
            type="password"
            placeholder="lin_api_…"
            aria-label="Linear API key"
            autoComplete="off"
            value={key}
            onChange={(e) => setKey(e.target.value)}
            onKeyDown={(e) => isEnter(e) && connect()}
          />
          <button className="btn primary sm" disabled={busy || !key.trim()} onClick={connect}>
            Connect
          </button>
        </Row>
      )}
    </Group>
  );
}
