// Codex setup migration detection, source grouping and import actions.

import { useEffect, useMemo, useState } from 'react';
import { useStore, setPrefs, toast } from '../../../store/core';
import { currentCwdForNewChat } from '../../../store/projects';
import { codexRequest } from '../../../harness/adapters/codex';
import { errorText } from '../../../lib/ignored';
import { Spinner } from '../../ui/icons';
import { Group, Row, Toggle } from '../../pages/Settings';
import type { ExternalAgentConfigDetectResponse } from '../../../protocol/v2/ExternalAgentConfigDetectResponse';
import type { ExternalAgentConfigMigrationItem } from '../../../protocol/v2/ExternalAgentConfigMigrationItem';

import { LoadFailed } from './settingsShared';
import { importSource } from '../../../lib/codexImportSource';

export { importSource };

export function ImportSection() {
  const prefs = useStore((s) => s.prefs);
  const [items, setItems] = useState<ExternalAgentConfigMigrationItem[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  // a detection that failed: said with Retry, not "Nothing to import"
  const [error, setError] = useState<string | null>(null);
  const detect = () => {
    setItems(null);
    setError(null);
    codexRequest<ExternalAgentConfigDetectResponse>('externalAgentConfig/detect', {
      includeHome: true,
      cwds: [currentCwdForNewChat()],
    }).then(
      (r) => setItems(r.items ?? []),
      (e: unknown) => {
        setItems([]);
        setError(errorText(e));
      },
    );
  };
  useEffect(detect, []);
  const sources = useMemo(() => {
    const m = new Map<string, { id: string; name: string; items: ExternalAgentConfigMigrationItem[] }>();
    for (const it of items ?? []) {
      const src = importSource(it);
      if (!m.has(src.id)) m.set(src.id, { ...src, items: [] });
      m.get(src.id)!.items.push(it);
    }
    return [...m.values()];
  }, [items]);
  const imported = prefs.importedSources ?? [];
  return (
    <>
      <p className="settings-sub settings-lead">
        Bring setup, projects, and chats from other AI apps into Codex. Claude Code already reads ~/.claude, so there is nothing to import
        for it.
      </p>
      <Group title="Automatic sync to Codex">
        <Row title="Keep imports in sync" desc="Automatically sync new and updated content from connected sources">
          <Toggle on={prefs.importSync} onChange={(v) => setPrefs({ importSync: v })} />
        </Row>
        <Row
          title="Content to sync"
          desc={
            imported.length
              ? `Syncing ${imported.length === 1 ? 'one source' : `${imported.length} sources`}`
              : 'Available after your first import'
          }
        >
          <button className="btn-pill ghost" disabled={!imported.length} onClick={() => setPrefs({ importedSources: [] })}>
            {imported.length ? 'Stop syncing' : 'Customize'}
          </button>
        </Row>
      </Group>
      <Group title="Import to Codex" desc="Detected setup that can be added to Codex">
        {items === null && (
          <Row title="Checking for imports">
            <Spinner size={14} />
          </Row>
        )}
        {error && <LoadFailed what="look for setup to import" error={error} retry={detect} />}
        {items?.length === 0 && !error && <Row title="Nothing to import" desc="No compatible setup was found on this Mac" />}
        {sources.map((src) => (
          <Row
            key={src.id}
            title={
              <span className="import-src">
                <span className={`import-logo ${src.id}`} />
                {src.name}
              </span>
            }
          >
            <button
              className="btn-pill soft"
              disabled={busy !== null}
              onClick={async () => {
                setBusy(src.id);
                try {
                  await codexRequest('externalAgentConfig/import', { migrationItems: src.items });
                  setPrefs({ importedSources: [...new Set([...imported, src.id])] });
                  toast(`Imported from ${src.name}`);
                  detect();
                } catch (e) {
                  toast(errorText(e), 'error');
                }
                setBusy(null);
              }}
            >
              {busy === src.id ? <Spinner size={12} /> : 'Import'}
            </button>
          </Row>
        ))}
      </Group>
    </>
  );
}

/* ------------------------------------------------------------------ */
/* Configuration (config.toml)                                         */
/* ------------------------------------------------------------------ */
