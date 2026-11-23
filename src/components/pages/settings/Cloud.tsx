// Codex Cloud settings: environments.

import { Row } from './Controls';
import { Search, Spinner } from '../../ui/icons';
import { useEffect, useState } from 'react';
import { native } from '../../../lib/native';
import { errorText } from '../../../lib/ignored';
import { openLink } from '../../../session/open';

/* ------------------------------------------------------------------ */
/* Codex Cloud                                                         */
/* ------------------------------------------------------------------ */
export function CloudSettings() {
  const [envs, setEnvs] = useState<{ id: string; label: string; repo: string | null }[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [q, setQ] = useState('');
  useEffect(() => {
    native.cloud.envs().then(
      (r) => {
        setEnvs(r.envs ?? []);
        setErr(r.error ?? null);
      },
      // a request that failed says why where the list would be, instead of loading forever
      (e) => {
        setEnvs([]);
        setErr(`Couldn't list the environments: ${errorText(e)}`);
      },
    );
  }, []);
  const list = (envs ?? []).filter((e) => !q || e.label.toLowerCase().includes(q.toLowerCase()));
  return (
    <>
      <p className="settings-sub settings-lead">Cloud environments</p>
      <div className="settings-group-head">
        <h2 className="settings-group-title">Environments</h2>
      </div>
      <div className="archived-bar">
        <div className="pill-search wide">
          <Search size={14} strokeWidth={1.7} />
          <input placeholder="Search environments" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        <button className="btn-pill" onClick={() => openLink('https://chatgpt.com/codex/settings/environments')}>
          Create environment
        </button>
      </div>
      {!envs && <Spinner size={16} />}
      {envs && list.length === 0 && <div className="connections-empty">{err ?? 'No saved environments'}</div>}
      {list.length > 0 && (
        <div className="settings-card">
          {list.map((e) => (
            <Row key={e.id} title={e.label} desc={e.repo ?? e.id}>
              <button className="btn-pill soft" onClick={() => openLink(`https://chatgpt.com/codex/settings/environment/${e.id}`)}>
                Edit
              </button>
            </Row>
          ))}
        </div>
      )}
    </>
  );
}
