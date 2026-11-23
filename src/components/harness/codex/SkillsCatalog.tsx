// The Codex skills catalog: installed skills, the personal, project and system scopes, and a skill's detail.

import { basename, dirname, isAbsolutePath, isUnder, joinPath, samePath } from '../../../lib/paths';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useEffectOn } from '../../../lib/effects';
import { useStore, toast } from '../../../store/core';
import { navigate } from '../../../store/panes';
import { codexRequest } from '../../../harness/adapters/codex';
import { native } from '../../../lib/native';
import { errorText } from '../../../lib/ignored';
import { openLink } from '../../../session/open';
import { Markdown } from '../../markdown/Markdown';
import { Search, RefreshCw, Settings as Gear, Check, Plus, X, Ellipsis, Spinner, MessageCirclePlus } from '../../ui/icons';
import { Tooltip } from '../../ui/Popover';
import { useFileMenu } from '../../ui/FileMenu';
import { listCodexSkills } from '../../../harness/codexSkills';
import { SKILL_GEM } from '../../../lib/brandColors';

interface Skill {
  name: string;
  description: string;
  path: string;
  scope: string;
  enabled: boolean;
  pluginId?: string | null;
  interface?: { displayName?: string; shortDescription?: string } | null;
  cwd: string;
}

const title = (s: Skill) =>
  s.interface?.displayName ??
  s.name
    .split(':')
    .pop()!
    .replace(/[-_]+/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase());

/** Rainbow cube: the official skill glyph. */
function SkillIcon({ size = 36 }: { size?: number }) {
  return (
    <span className="skill-icon" style={{ width: size, height: size }}>
      <svg width={size * 0.5} height={size * 0.5} viewBox="0 0 24 24">
        <defs>
          <linearGradient id="skg" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" stopColor={SKILL_GEM.stops[0]} />
            <stop offset="0.5" stopColor={SKILL_GEM.stops[1]} />
            <stop offset="1" stopColor={SKILL_GEM.stops[2]} />
          </linearGradient>
        </defs>
        <path d="M12 2l9 5v10l-9 5-9-5V7z" fill="url(#skg)" />
        <path d="M12 12l9-5M12 12v10M12 12L3 7" stroke={SKILL_GEM.facets} strokeWidth="1" fill="none" />
      </svg>
    </span>
  );
}

/** Skills catalog, laid out like the official page: Installed, then scope tabs (Personal, projects, System). */
export function SkillsCatalog() {
  const projects = useStore((s) => s.savedProjects);
  const [skills, setSkills] = useState<Skill[] | null>(null);
  const [q, setQ] = useState('');
  const [tab, setTab] = useState('user');
  const [more, setMore] = useState<Record<string, boolean>>({});
  const [open, setOpen] = useState<Skill | null>(null);
  // the projects' folders the catalog lists skills for
  const cwds = [...new Set(projects.map((p) => p.roots[0]?.path).filter(Boolean))] as string[];
  // the set of folders, whatever the projects' order
  const folders = [...cwds].sort().join('\n');
  // overlapping reads (a refresh, another set of folders): only the newest is shown
  const reads = useRef(0);
  const load = async (force = false) => {
    const read = ++reads.current;
    try {
      const listed = await listCodexSkills(cwds, force);
      if (read !== reads.current) return;
      setSkills(listed);
    } catch (e) {
      if (read !== reads.current) return;
      setSkills((previous) => previous ?? []);
      toast(errorText(e), 'error');
    }
  };
  // a project added, removed or moved to another folder lists again
  useEffectOn([folders], () => {
    // cannot reject: load says itself why the skills couldn't be listed
    void load();
  });
  // Plugin-namespaced skills ("plugin:skill") are listed under their plugin, as in the official catalog.
  const list = useMemo(
    () =>
      (skills ?? [])
        .filter((k) => !k.name.includes(':'))
        .filter((k) => !q || title(k).toLowerCase().includes(q.toLowerCase()) || k.description.toLowerCase().includes(q.toLowerCase()))
        .sort((a, b) => title(a).localeCompare(title(b))),
    [skills, q],
  );
  // Scope tabs: Personal (user), one per project with repo skills, System.
  const tabs = useMemo(() => {
    // A project's tab holds skills from <root>/.codex/skills (and repo-scope ones); other user skills are Personal.
    const projectOf = (k: Skill) =>
      projects.find(
        (p) =>
          p.roots[0]?.path &&
          (isUnder(k.path, joinPath(p.roots[0].path, '.codex/skills')) || (k.scope === 'repo' && samePath(k.cwd ?? '', p.roots[0].path))),
      );
    const t: { id: string; label: string; items: Skill[] }[] = [
      { id: 'user', label: 'Personal', items: list.filter((k) => k.scope !== 'system' && !projectOf(k)) },
    ];
    for (const p of projects) {
      const items = list.filter((k) => k.scope !== 'system' && projectOf(k)?.id === p.id);
      if (items.length) t.push({ id: 'p:' + p.id, label: p.name, items });
    }
    t.push({ id: 'system', label: 'System', items: list.filter((k) => k.scope === 'system') });
    return t.filter((x) => x.items.length);
  }, [list, projects]);
  const cur = tabs.find((t) => t.id === tab) ?? tabs[0];
  /** Turn a skill on or off, then list again; true when the change went through (a failure is a toast). */
  const toggle = async (k: Skill, enabled: boolean) => {
    const done = await codexRequest('skills/config/write', { path: k.path, enabled }).then(
      () => true,
      (e) => (toast(errorText(e), 'error'), false),
    );
    await load(true);
    return done;
  };
  return (
    <div className="page plugins-page">
      <div className="page-header">
        <div>
          <h1 className="page-title">Skills</h1>
          <p className="page-sub">Extend Codex with task-specific skills</p>
        </div>
        <div className="plugins-tools">
          <div className="pill-search">
            <Search size={14} strokeWidth={1.7} />
            <input placeholder="Search skills" value={q} onChange={(e) => setQ(e.target.value)} />
          </div>
          <Tooltip label="Refresh">
            <button className="icon-btn" onClick={() => load(true)} aria-label="Refresh">
              <RefreshCw size={15} strokeWidth={1.7} />
            </button>
          </Tooltip>
          <Tooltip label="Skill settings">
            <button
              className="icon-btn"
              onClick={() => navigate({ name: 'settings', section: 'plugins', tab: 'skills' })}
              aria-label="Skill settings"
            >
              <Gear size={15} strokeWidth={1.7} />
            </button>
          </Tooltip>
          <button className="btn-white add-btn" onClick={() => openLink('https://developers.openai.com/codex/skills')}>
            Add
          </button>
        </div>
      </div>
      {!skills && <Spinner size={16} />}
      {skills && (
        <>
          <SkillSection
            title="Installed"
            items={list.filter((k) => k.enabled)}
            expanded={!!more.installed}
            onMore={() => setMore((m) => ({ ...m, installed: !m.installed }))}
            onOpen={setOpen}
          />
          {cur && (
            <>
              <div className="segmented tabs-seg skill-tabs">
                {tabs.map((t) => (
                  <button key={t.id} className={t.id === cur.id ? 'on' : ''} onClick={() => setTab(t.id)}>
                    {t.label}
                  </button>
                ))}
              </div>
              <SkillSection
                items={cur.items}
                expanded={!!more[cur.id]}
                onMore={() => setMore((m) => ({ ...m, [cur.id]: !m[cur.id] }))}
                onOpen={setOpen}
              />
            </>
          )}
        </>
      )}
      {open && (
        <SkillDetail
          key={open.path}
          skill={open}
          onClose={() => setOpen(null)}
          // the open detail shows the new state only once it was written
          onToggle={(v) => toggle(open, v).then((done) => done && setOpen({ ...open, enabled: v }))}
          onRemoved={async () => {
            setSkills((previous) => previous!.filter((k) => !samePath(k.path, open.path)));
            setOpen(null);
            await load(true);
          }}
        />
      )}
    </div>
  );
}

function SkillSection({
  title: heading,
  items,
  expanded,
  onMore,
  onOpen,
}: {
  title?: string;
  items: Skill[];
  expanded: boolean;
  onMore: () => void;
  onOpen: (k: Skill) => void;
}) {
  const shown = expanded ? items : items.slice(0, 6);
  const rest = items.slice(6);
  return (
    <section className="skill-section">
      {heading && <div className="plugin-section-title static">{heading}</div>}
      <div className="plugin-rows">
        {shown.map((k) => (
          <button type="button" key={k.path} className="plugin-row" onClick={() => onOpen(k)}>
            <SkillIcon />
            <span className="plugin-row-text">
              <span className="plugin-name">{title(k)}</span>
              <span className="plugin-desc">{k.interface?.shortDescription ?? k.description}</span>
            </span>
            <span className="skill-state">{k.enabled ? <Check size={16} strokeWidth={1.7} /> : <Plus size={16} strokeWidth={1.7} />}</span>
          </button>
        ))}
      </div>
      {rest.length > 0 && (
        <button className="skill-more" onClick={onMore}>
          {expanded ? 'Show less' : `See ${rest.slice(0, 2).map(title).join(', ')}, and ${Math.max(0, rest.length - 2)} more`}
        </button>
      )}
    </section>
  );
}

function SkillDetail({
  skill,
  onClose,
  onToggle,
  onRemoved,
}: {
  skill: Skill;
  onClose: () => void;
  onToggle: (v: boolean) => void;
  onRemoved: () => Promise<void>;
}) {
  const [body, setBody] = useState<string | null>(null);
  const [readError, setReadError] = useState<string | null>(null);
  const [confirmRemoval, setConfirmRemoval] = useState(false);
  const [removing, setRemoving] = useState(false);
  const m = useFileMenu(skill.path);
  useEffect(() => {
    let live = true;
    setBody(null);
    setReadError(null);
    // a SKILL.md that can't be read says why instead of loading forever
    native.fs.readText(skill.path).then(
      (t) => live && setBody((t ?? '').replace(/^---[\s\S]*?\n---\n?/, '')),
      (e) => live && setReadError(errorText(e)),
    );
    return () => {
      live = false;
    };
  }, [skill.path]);
  const removable =
    (skill.scope === 'user' || skill.scope === 'repo') &&
    !skill.pluginId &&
    isAbsolutePath(skill.path) &&
    basename(skill.path).toLowerCase() === 'skill.md';
  const dir = dirname(skill.path);
  const uninstall = async () => {
    if (!removable || removing) return;
    setRemoving(true);
    try {
      const result = await native.fs.remove(dir);
      if (!result.ok) throw new Error(result.error || 'Could not uninstall this skill');
    } catch (e) {
      toast(errorText(e), 'error');
      setRemoving(false);
      return;
    }
    toast(`Uninstalled ${title(skill)}`);
    await onRemoved();
  };
  return (
    <div className="sketch-backdrop" onMouseDown={(e) => !removing && e.target === e.currentTarget && onClose()}>
      <div className="skill-detail" role={confirmRemoval ? 'alertdialog' : 'dialog'} aria-labelledby="skill-detail-title">
        <div className="skill-detail-head">
          <SkillIcon size={46} />
          <span className="flex1" />
          <button
            className={`toggle ${skill.enabled ? 'on' : ''}`}
            role="switch"
            aria-checked={skill.enabled}
            disabled={removing || confirmRemoval}
            onClick={() => onToggle(!skill.enabled)}
          >
            <span className="toggle-knob" />
          </button>
          <button className="icon-btn" {...m.trigger} disabled={removing} aria-label="Skill actions">
            <Ellipsis size={16} />
          </button>
          <button className="icon-btn" disabled={removing} onClick={onClose} aria-label="Close">
            <X size={16} />
          </button>
        </div>
        <div className="skill-detail-title" id="skill-detail-title">
          {title(skill)} <span>Skill</span>
        </div>
        <div className="skill-detail-desc">{skill.interface?.shortDescription ?? skill.description.split('. ')[0]}</div>
        <div className="skill-detail-body">
          {confirmRemoval ? (
            <p style={{ overflowWrap: 'anywhere' }}>
              Uninstall {title(skill)}? This permanently deletes {dir} and its contents.
            </p>
          ) : readError ? (
            <p className="settings-row-desc">
              Couldn't read {basename(skill.path)}: {readError}
            </p>
          ) : body == null ? (
            <Spinner size={14} />
          ) : (
            <Markdown text={body} />
          )}
        </div>
        <div className="skill-detail-foot">
          {confirmRemoval ? (
            <>
              <button className="btn-pill" disabled={removing} onClick={() => setConfirmRemoval(false)}>
                Cancel
              </button>
              <button className="btn-pill danger outline" disabled={removing} onClick={uninstall}>
                {removing ? 'Uninstalling…' : 'Uninstall'}
              </button>
            </>
          ) : (
            <>
              {removable ? (
                <button className="btn-pill danger outline" onClick={() => setConfirmRemoval(true)}>
                  Uninstall
                </button>
              ) : (
                <span />
              )}
              <button
                className="btn-white lg"
                onClick={() => {
                  navigate({ name: 'home' });
                  setTimeout(
                    () =>
                      window.dispatchEvent(
                        new CustomEvent('insert-skill', { detail: { name: skill.name, path: skill.path, displayName: title(skill) } }),
                      ),
                    150,
                  );
                  onClose();
                }}
              >
                <MessageCirclePlus size={15} /> Try now
              </button>
            </>
          )}
        </div>
        {m.menu}
      </div>
    </div>
  );
}
