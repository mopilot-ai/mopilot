// Settings → Git: the branch prefix, then the worktree folder and cleanup and the local environments below it.

import { Group, Row, Toggle } from './Controls';
import { abbreviateHome, basename, isAbsolutePath } from '../../../lib/paths';
import { ChevronLeft, ChevronRight, Trash2, Spinner, RefreshCw, Folder } from '../../ui/icons';
import { useRef, useState } from 'react';
import { useEffectOn } from '../../../lib/effects';
import { useStore, setPrefs, toast } from '../../../store/core';
import { createProject } from '../../../store/projects';
import { inCodexWorktrees, worktreeRootOf } from '../../../store/types';
import { native } from '../../../lib/native';
import { errorText } from '../../../lib/ignored';
import { openFile } from '../../../session/open';
import { useRowIds } from '../../../lib/listKeys';
import { WebLink } from '../../ui/WebLink';
import {
  readEnvironment,
  resolveEnvironment,
  writeEnvironment,
  envPath,
  type LocalEnvironment,
  type ResolvedEnvironment,
} from '../../../lib/environments';
import { ConductorEnvironment } from './ConductorEnvironment';
import { ConductorImport } from './ConductorImport';

/* ------------------------------------------------------------------ */
/* Git                                                                 */
/* ------------------------------------------------------------------ */
export function GitSettings() {
  const prefs = useStore((s) => s.prefs);
  return (
    <>
      <Group>
        <Row title="Branch prefix" desc="Prefix used when an agent creates new branches">
          <input className="text-input slim" value={prefs.branchPrefix} onChange={(e) => setPrefs({ branchPrefix: e.target.value })} />
        </Row>
        <Row
          title="Show only last turn changes"
          desc="The Changes pane shows what the last turn changed instead of the repository's uncommitted or branch diff"
        >
          <Toggle on={prefs.changesLastTurnOnly} onChange={(v) => setPrefs({ changesLastTurnOnly: v })} />
        </Row>
      </Group>
    </>
  );
}

/* ------------------------------------------------------------------ */
/* Worktrees                                                           */
/* ------------------------------------------------------------------ */
/** A worktree folder typed here that main can't use: not a full path or one under ~ (electron/platform/git.cjs rootOf). */
const notFullPath = (p: string | null) => {
  const r = p?.trim() ?? '';
  return !!r && r !== '~' && !/^~[\\/]/.test(r) && !isAbsolutePath(r);
};

export function Worktrees() {
  const prefs = useStore((s) => s.prefs);
  const home = useStore((s) => s.home);
  const codexHome = useStore((s) => s.codexHome);
  const [list, setList] = useState<{ path: string; branch: string | null }[] | null>(null);
  // why the list couldn't be read: shown with Retry instead of "No worktrees yet"
  const [error, setError] = useState<string | null>(null);
  const root = worktreeRootOf(prefs, home);
  const reads = useRef(0);
  /** List the worktrees; it cannot reject (a list it couldn't read is shown with Retry), and only the latest read is shown. */
  const load = async () => {
    const read = ++reads.current;
    setList(null);
    setError(null);
    const r = await native.git.worktreeList(root).then(
      (found) => ({ found, error: null }),
      (e: unknown) => ({ found: [], error: errorText(e) }),
    );
    if (read !== reads.current) return;
    setList(r.found);
    setError(r.error);
  };
  // another worktree folder lists its own worktrees
  useEffectOn([root], () => {
    void load();
  });
  const [tab, setTab] = useState<'general' | 'env'>('general');
  if (tab === 'env')
    return (
      <>
        <WorktreeTabs tab={tab} setTab={setTab} />
        <LocalEnvironments />
      </>
    );
  return (
    <>
      <WorktreeTabs tab={tab} setTab={setTab} />
      <Group>
        <Row
          title="Worktree root"
          desc={
            notFullPath(prefs.worktreeRoot)
              ? 'Use a full path, like ~/worktrees. New worktrees can’t be made until then.'
              : codexHome && inCodexWorktrees(prefs.worktreeRoot, home, codexHome)
                ? 'The Codex app deletes worktrees in its own folder, even ones a chat is using. New worktrees can’t be made here.'
                : 'Leave empty to use the default folder.'
          }
        >
          <input
            className="text-input slim wide"
            placeholder={worktreeRootOf({ worktreeRoot: null }, home)}
            value={prefs.worktreeRoot ?? ''}
            onChange={(e) => setPrefs({ worktreeRoot: e.target.value || null })}
          />
        </Row>
        <Row title="Delete old worktrees" desc="Remove older managed worktrees when the limit is reached.">
          <Toggle on={prefs.autoDeleteWorktrees} onChange={(v) => setPrefs({ autoDeleteWorktrees: v })} />
        </Row>
        <Row
          title="Delete branch on archive"
          desc="Archiving a chat in a worktree removes the worktree and deletes its branch, when nothing on them can be lost: every commit is pushed or on another branch, and nothing is uncommitted or ignored. Otherwise both stay. Unarchiving the chat brings the branch back."
        >
          <Toggle on={!!prefs.deleteBranchOnArchive} onChange={(v) => setPrefs({ deleteBranchOnArchive: v })} />
        </Row>
        <Row title="Worktrees to keep">
          <input
            className="text-input slim num"
            type="number"
            min={1}
            value={prefs.autoDeleteLimit}
            onChange={(e) => setPrefs({ autoDeleteLimit: Number(e.target.value) || 15 })}
          />
        </Row>
      </Group>
      <Group
        title={list && list.length ? `${list.length} worktrees` : error ? 'Worktrees' : 'No worktrees yet'}
        action={
          <button className="icon-btn" onClick={load} title="Refresh">
            <RefreshCw size={14} />
          </button>
        }
      >
        {!list && (
          <div className="settings-pad">
            <Spinner size={14} />
          </div>
        )}
        {error && (
          <div className="config-warning" role="alert">
            Couldn't list the worktrees: {error}{' '}
            <button className="btn-pill soft" onClick={load}>
              Retry
            </button>
          </div>
        )}
        {list?.length === 0 && !error && (
          <div className="settings-pad center-text settings-row-desc">Worktrees created by MoPilot will appear here</div>
        )}
        {list?.map((w) => (
          <Row key={w.path} title={basename(w.path)} desc={`${w.branch ?? ''} · ${w.path}`}>
            <button className="btn-pill" onClick={() => openFile(w.path)}>
              Open
            </button>
          </Row>
        ))}
      </Group>
      <ConductorImport />
    </>
  );
}

function WorktreeTabs({ tab, setTab }: { tab: 'general' | 'env'; setTab: (t: 'general' | 'env') => void }) {
  return (
    <div className="segmented tabs-seg">
      <button className={tab === 'general' ? 'on' : ''} onClick={() => setTab('general')}>
        General
      </button>
      <button className={tab === 'env' ? 'on' : ''} onClick={() => setTab('env')}>
        Environments
      </button>
    </div>
  );
}

/** Local environments: per-project setup/cleanup scripts and actions (.codex/environments/environment.toml). */
function LocalEnvironments() {
  const projects = useStore((s) => s.savedProjects);
  const [sel, setSel] = useState<string | null>(null);
  const proj = projects.find((p) => p.id === sel);
  if (proj) return <EnvironmentEditor root={proj.roots[0].path} name={proj.name} onBack={() => setSel(null)} />;
  return (
    <>
      <p className="settings-sub settings-lead env-lead">
        Local environments tell the agent how to set up worktrees for a project.{' '}
        <WebLink href="https://developers.openai.com/codex">Learn more</WebLink>
      </p>
      <Group
        title="Select a project"
        action={
          <button
            className="btn-pill soft"
            onClick={async () => {
              const p = await native.dialog.openFolder();
              // cannot reject: createProject says itself why a project couldn't be added
              if (p) void createProject(p);
            }}
          >
            Add project
          </button>
        }
      >
        {projects.map((p) => (
          <Row
            key={p.id}
            title={
              <span className="import-src">
                <Folder size={15} strokeWidth={1.7} />
                {p.name}
              </span>
            }
            onClick={() => setSel(p.id)}
          >
            <ChevronRight size={16} />
          </Row>
        ))}
      </Group>
    </>
  );
}

const ACTION_ICONS = ['tool', 'run', 'debug', 'test'] as const;
function EnvironmentEditor({ root, name, onBack }: { root: string; name: string; onBack: () => void }) {
  const [env, setEnv] = useState<LocalEnvironment | null>(null);
  const [dirty, setDirty] = useState(false);
  // a file that couldn't be read: no editor, so saving can't replace what it never read
  const [readError, setReadError] = useState<string | null>(null);
  // where main takes this project's scripts from: Conductor's files are shown as they are, with a way to convert them
  const [resolved, setResolved] = useState<ResolvedEnvironment | null>(null);
  const [reads, setReads] = useState(0);
  const actionRows = useRowIds(env?.actions?.length ?? 0);
  // read again when the project changes, and after a conversion (`reads`) made its environment.toml
  useEffectOn([root, name, reads], () => {
    let live = true;
    setReadError(null);
    setResolved(null);
    resolveEnvironment(root)
      .then(async (r) => ({ r, e: r.source === 'environment' ? await readEnvironment(root) : null }))
      .then(
        ({ r, e }) => {
          if (!live) return;
          setResolved(r);
          setEnv(e ?? { version: 1, name, setup: { script: '' }, actions: [] });
          setDirty(false);
        },
        (e) => live && setReadError(errorText(e)),
      );
    return () => {
      live = false;
    };
  });
  if (readError)
    return (
      <>
        <button className="link-muted" onClick={onBack}>
          <ChevronLeft size={14} /> Environments
        </button>
        <div className="config-warning" role="alert">
          Couldn't read {name}'s environment: {readError}
        </div>
      </>
    );
  if (!env || !resolved) return <Spinner size={16} />;
  if (resolved.source === 'conductor' || resolved.source === 'conductor-json')
    return <ConductorEnvironment root={root} name={name} resolved={resolved} onBack={onBack} onConverted={() => setReads((n) => n + 1)} />;
  const patch = (p: Partial<LocalEnvironment>) => {
    setEnv({ ...env, ...p });
    setDirty(true);
  };
  const actions = env.actions ?? [];
  const removeAction = (i: number) => {
    actionRows.remove(i);
    patch({ actions: actions.filter((_, j) => j !== i) });
  };
  return (
    <>
      <div className="env-head">
        <button className="link-muted" onClick={onBack}>
          <ChevronLeft size={14} /> Environments
        </button>
        <button
          className="btn-white"
          disabled={!dirty}
          onClick={async () => {
            try {
              await writeEnvironment(root, env);
              setDirty(false);
              // the saved file is the project's source from here on
              setResolved({ ...resolved, source: 'environment' });
              toast('Environment saved');
            } catch (e) {
              toast(errorText(e), 'error');
            }
          }}
        >
          Save
        </button>
      </div>
      {resolved.notice && (
        <div className="config-warning" role="alert">
          {resolved.notice}
        </div>
      )}
      <Group
        title={name}
        desc={
          // where this project's setup script, cleanup script and actions come from
          <span className="settings-path" data-env-source>
            {resolved.source ? 'Source: ' : 'No environment yet; saving creates '}
            {abbreviateHome(envPath(root))}
          </span>
        }
      >
        <Row title="Name">
          <input className="text-input slim wide" value={env.name} onChange={(e) => patch({ name: e.target.value })} />
        </Row>
      </Group>
      <section className="settings-group">
        <h2 className="settings-group-title">Setup script</h2>
        <div className="settings-group-desc">Runs in each new worktree before the agent starts working</div>
        <textarea
          className="text-area settings-textarea mono"
          rows={5}
          value={env.setup.script}
          placeholder="npm install"
          onChange={(e) => patch({ setup: { script: e.target.value } })}
        />
      </section>
      <section className="settings-group">
        <h2 className="settings-group-title">Cleanup script</h2>
        <div className="settings-group-desc">Runs before a worktree is removed</div>
        <textarea
          className="text-area settings-textarea mono"
          rows={3}
          value={env.cleanup?.script ?? ''}
          onChange={(e) => patch({ cleanup: { script: e.target.value } })}
        />
      </section>
      <Group
        title="Actions"
        desc="Commands you can run from a chat’s menu; they open in a terminal tab"
        action={
          <button className="btn-pill soft" onClick={() => patch({ actions: [...actions, { name: 'Run', icon: 'run', command: '' }] })}>
            Add action
          </button>
        }
      >
        {actions.length === 0 && <div className="connections-empty">No actions</div>}
        {actions.map((a, i) => (
          <div key={actionRows.ids[i]} className="env-action">
            <select
              className="text-input slim"
              value={a.icon ?? 'tool'}
              onChange={(e) =>
                patch({ actions: actions.map((x, j) => (j === i ? { ...x, icon: e.target.value as (typeof x)['icon'] } : x)) })
              }
            >
              {ACTION_ICONS.map((ic) => (
                <option key={ic} value={ic}>
                  {ic}
                </option>
              ))}
            </select>
            <input
              className="text-input slim"
              placeholder="Name"
              value={a.name}
              onChange={(e) => patch({ actions: actions.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)) })}
            />
            <input
              className="text-input slim wide mono"
              placeholder="npm run dev"
              value={a.command}
              onChange={(e) => patch({ actions: actions.map((x, j) => (j === i ? { ...x, command: e.target.value } : x)) })}
            />
            <button className="icon-btn xs" aria-label="Remove action" onClick={() => removeAction(i)}>
              <Trash2 size={14} />
            </button>
          </div>
        ))}
      </Group>
    </>
  );
}
