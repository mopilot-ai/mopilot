// The All harnesses tab of the Skills page: every skill the user has in one list, one switch where a harness has one, and only where a skill is missing or off said.
import { useState } from 'react';
import { setCodexSkillEnabled } from '../../harness/codexSkills';
import type { ReactNode } from 'react';
import { Toggle } from '../pages/Settings';
import { Card } from '../plugins/PluginCards';
import { attempt } from '../plugins/pluginView';
import { Sparkles } from '../ui/icons';
import { pluralize } from '../../lib/format';
import { skillException, type SkillRow } from './mergeSkills';
import { SkillDetailDialog } from './SkillDetailDialog';
import { useAllSkills } from './useAllSkills';

const tile = (
  <span className="plugin-tile" style={{ width: 40, height: 40 }}>
    <Sparkles size={20} strokeWidth={1.6} />
  </span>
);

/** A line the page says about itself (loading, none, a source that failed), set like a settings row. */
function Note({ title, desc, children }: { title: string; desc?: string; children?: ReactNode }) {
  return (
    <section className="settings-group">
      <div className="settings-card">
        <div className="settings-row">
          <div className="settings-row-text">
            <div className="settings-row-title">{title}</div>
            {desc && <div className="settings-row-desc">{desc}</div>}
          </div>
          {children && <div className="settings-row-control">{children}</div>}
        </div>
      </div>
    </section>
  );
}

export function AllSkills({ codexOk = true }: { codexOk?: boolean }) {
  const { rows, errors, reload } = useAllSkills(codexOk);
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState<string | null>(null);
  const q = query.trim().toLowerCase();
  const shown = (rows ?? []).filter((r) => !q || r.title.toLowerCase().includes(q) || r.description.toLowerCase().includes(q));
  const opened = rows?.find((r) => r.key === open);
  const setCodex = (r: SkillRow, enabled: boolean) => attempt(() => setCodexSkillEnabled(r.codex!.path, enabled)).then(reload);
  return (
    <div className="page plugins-page">
      <div className="page-header">
        <h1 className="page-title">Skills</h1>
      </div>
      {rows && rows.length > 0 && (
        <div className="plugin-store-bar">
          <input
            className="plugin-store-search"
            aria-label="Search skills"
            placeholder="Search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
      )}
      {errors.length > 0 && (
        <Note title="Couldn't read all skills" desc={errors.join(' ')}>
          <button className="btn-pill soft" onClick={() => void reload()}>
            Retry
          </button>
        </Note>
      )}
      {!rows ? (
        <Note title="Loading…" />
      ) : rows.length === 0 ? (
        !errors.length && <Note title="No skills yet" />
      ) : shown.length === 0 ? (
        <Note title="No skills match" />
      ) : (
        <>
          <div className="plugin-card-meta">{pluralize(shown.length, 'skill')}</div>
          <div className="plugin-grid">
            {shown.map((r) => (
              <Card
                key={r.key}
                tile={tile}
                title={r.title}
                desc={r.description}
                meta={skillException(r) ?? undefined}
                onOpen={() => setOpen(r.key)}
              >
                {r.codex ? <Toggle on={r.codex.enabled} label={`${r.title} on or off`} onChange={(on) => setCodex(r, on)} /> : null}
              </Card>
            ))}
          </div>
        </>
      )}
      {opened && <SkillDetailDialog row={opened} onClose={() => setOpen(null)} />}
    </div>
  );
}
