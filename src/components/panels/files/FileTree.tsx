// The Files pane's tree of the working directory: folders read as they open, the open file set apart and revealed on request, a name filter (fuzzy) and a `?` search of the files' contents.

import { fileName } from '../../../lib/paths';
import { isWin } from '../../../lib/platform';
import { useEffect, useRef, useState } from 'react';
import { native } from '../../../lib/native';
import { ChevronRight, ChevronDown, Folder, FolderOpen, Search, Spinner } from '../../ui/icons';
import { LangIcon } from '../DiffPanel';
import { errorText } from '../../../lib/ignored';
import { useEffectOn } from '../../../lib/effects';
import type { LineSpan } from '../../../lib/lineSpan';
import { revealing } from '../../../lib/filesWorkspace';

interface Entry {
  fileName: string;
  isDirectory: boolean;
}
const HIDDEN = new Set(['.git', 'node_modules', '.DS_Store', 'dist', 'out', '.next', '__pycache__', '.venv']);
/** How long typing pauses before a search runs: a name search is cheap, a content search reads every file. */
const NAME_DELAY_MS = 120;
const TEXT_DELAY_MS = 250;

type TextMatch = { path: string; line: number; column: number; text: string };
type Results =
  | { kind: 'names'; files: string[] }
  | { kind: 'text'; matches: TextMatch[]; truncated: boolean; query: string }
  | { kind: 'pending' };

/** What the filter asks for: a `?` at its start searches the contents for the rest, else names match fuzzily. */
export function filterQuery(filter: string): { kind: 'names' | 'text'; query: string } | null {
  const text = filter.startsWith('?');
  const query = (text ? filter.slice(1) : filter).trim();
  return query ? { kind: text ? 'text' : 'names', query } : null;
}

/** Content matches by file, in the order ripgrep found them. */
export function groupMatches(matches: readonly TextMatch[]): { path: string; lines: TextMatch[] }[] {
  const out = new Map<string, TextMatch[]>();
  for (const m of matches) out.set(m.path, [...(out.get(m.path) ?? []), m]);
  return [...out].map(([path, lines]) => ({ path, lines }));
}

/** Whether `path` is `folder` or under it, by path segments. */
const within = (path: string, folder: string) => path.startsWith(`${folder.replace(/\/$/, '')}/`);

export function FileTree({
  cwd,
  active,
  reveal,
  onOpen,
}: {
  cwd: string;
  /** the file in front, set apart in the tree */
  active: string | null;
  /** a "Reveal in file tree" request: its folders open and its row scrolls into view */
  reveal: { path: string; seq: number; at: number } | null;
  onOpen: (path: string, span?: LineSpan) => void;
}) {
  const [filter, setFilter] = useState('');
  const [results, setResults] = useState<Results | null>(null);
  const [searchError, setSearchError] = useState<string | null>(null);
  // another folder starts at its tree, searching afresh: reset while rendering, so its first frame never shows the
  // old folder's results
  const [searchIn, setSearchIn] = useState(cwd);
  if (searchIn !== cwd) {
    setSearchIn(cwd);
    setResults(filterQuery(filter) ? { kind: 'pending' } : null);
    setSearchError(null);
  }
  const [searchAttempt, setSearchAttempt] = useState(0);
  // Retry (a new attempt) searches again for the same filter
  useEffectOn([filter, cwd, searchAttempt], () => {
    setSearchError(null);
    const asked = filterQuery(filter);
    if (!asked) {
      setResults(null);
      return;
    }
    let alive = true;
    setResults({ kind: 'pending' });
    const t = setTimeout(
      async () => {
        try {
          if (asked.kind === 'names') {
            const r = await native.search.files(cwd, asked.query, { limit: 60, dirs: false });
            if (alive) setResults({ kind: 'names', files: r.files.map((f) => `${cwd}/${f.path}`) });
          } else {
            const r = await native.search.text(cwd, asked.query, { limit: 200 });
            if (alive) setResults({ kind: 'text', matches: r.matches, truncated: r.truncated, query: asked.query });
          }
        } catch (error) {
          if (alive) {
            setResults(null);
            setSearchError(errorText(error) || 'Unknown error');
          }
        }
      },
      asked.kind === 'names' ? NAME_DELAY_MS : TEXT_DELAY_MS,
    );
    return () => {
      alive = false;
      clearTimeout(t);
    };
  });
  // a reveal clears the filter, so the tree (where the file is) shows
  useEffectOn([reveal?.seq], () => {
    if (revealing(reveal)) setFilter('');
  });

  return (
    <div className="files-tree-col">
      <div className="cp-filter files-filter">
        <Search size={15} strokeWidth={1.7} />
        <input
          placeholder="Filter files… (? searches contents)"
          aria-label="Filter files"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
      </div>
      <div className="files-tree">
        {searchError !== null && (
          <div role="alert">
            Could not search files: {searchError}.{' '}
            <button type="button" className="btn" aria-label="Retry file search" onClick={() => setSearchAttempt((attempt) => attempt + 1)}>
              Retry
            </button>
          </div>
        )}
        {results?.kind === 'pending' ? (
          <div className="file-node muted" style={{ paddingLeft: 12 }}>
            <Spinner size={12} />
          </div>
        ) : results?.kind === 'names' ? (
          results.files.length ? (
            results.files.map((p) => (
              <button
                key={p}
                className={`file-node ${p === active ? 'active' : ''}`}
                style={{ paddingLeft: 12 }}
                onClick={() => onOpen(p)}
                title={p}
              >
                <LangIcon path={p} />
                <span className="file-node-name">{p.slice(cwd.length + 1)}</span>
              </button>
            ))
          ) : (
            <div className="file-node muted">No files match</div>
          )
        ) : results?.kind === 'text' ? (
          <TextResults cwd={cwd} results={results} onOpen={onOpen} />
        ) : (
          <Dir key={cwd} path={cwd} depth={0} active={active} reveal={reveal} onOpen={onOpen} initiallyOpen />
        )}
      </div>
    </div>
  );
}

function TextResults({
  cwd,
  results,
  onOpen,
}: {
  cwd: string;
  results: { matches: TextMatch[]; truncated: boolean; query: string };
  onOpen: (path: string, span?: LineSpan) => void;
}) {
  if (!results.matches.length) return <div className="file-node muted">No results for “{results.query}”</div>;
  return (
    <>
      {groupMatches(results.matches).map(({ path, lines }) => (
        <div key={path} className="files-text-group">
          <div className="file-node files-text-file" title={path}>
            <LangIcon path={path} />
            <span className="file-node-name">{path}</span>
            <span className="files-text-count">{lines.length}</span>
          </div>
          {lines.map((m) => (
            <button
              key={`${m.line}:${m.column}`}
              className="file-node files-text-line"
              title={`${path}:${m.line}`}
              onClick={() => onOpen(`${cwd}/${path}`, { line: m.line })}
            >
              <span className="files-text-no">{m.line}</span>
              <span className="file-node-name">{m.text.trim()}</span>
            </button>
          ))}
        </div>
      ))}
      {results.truncated && <div className="file-node muted">More results were left out. Narrow the search.</div>}
    </>
  );
}

function Dir({
  path,
  depth,
  active,
  reveal,
  onOpen,
  initiallyOpen = false,
}: {
  path: string;
  depth: number;
  active: string | null;
  reveal: { path: string; seq: number; at: number } | null;
  onOpen: (p: string) => void;
  initiallyOpen?: boolean;
}) {
  const [expanded, setExpanded] = useState(initiallyOpen);
  const [entries, setEntries] = useState<Entry[] | null>(null);
  const [readError, setReadError] = useState<string | null>(null);
  // a reveal of a file under this folder opens it
  useEffectOn([reveal?.seq], () => {
    if (revealing(reveal) && within(reveal!.path, path)) setExpanded(true);
  });
  useEffect(() => {
    if (!expanded || entries || readError !== null) return;
    let alive = true;
    native.fs
      .readDir(path)
      .then((list) => {
        if (!alive) return;
        setEntries(
          list
            .filter((e) => !HIDDEN.has(e.fileName))
            .sort((a, b) => Number(b.isDirectory) - Number(a.isDirectory) || a.fileName.localeCompare(b.fileName)),
        );
      })
      .catch((error) => {
        if (alive) setReadError(errorText(error) || 'Unknown error');
      });
    return () => {
      alive = false;
    };
  }, [expanded, entries, readError, path]);
  const name = fileName(path, isWin);
  return (
    <>
      {depth > 0 && (
        <button className="file-node dir" style={{ paddingLeft: 8 + (depth - 1) * 14 }} onClick={() => setExpanded((x) => !x)}>
          {expanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
          {expanded ? <FolderOpen size={14} strokeWidth={1.7} /> : <Folder size={14} strokeWidth={1.7} />}
          <span className="file-node-name">{name}</span>
        </button>
      )}
      {expanded && !entries && readError === null && (
        <div className="file-node muted" style={{ paddingLeft: 8 + depth * 14 }}>
          <Spinner size={12} />
        </div>
      )}
      {expanded && readError !== null && (
        <button
          type="button"
          className="file-node muted"
          style={{ paddingLeft: 8 + depth * 14 }}
          aria-label={`Retry reading ${path}`}
          onClick={() => setReadError(null)}
        >
          Could not read folder: {readError}. Retry
        </button>
      )}
      {expanded &&
        entries?.map((e) =>
          e.isDirectory ? (
            <Dir key={e.fileName} path={`${path}/${e.fileName}`} depth={depth + 1} active={active} reveal={reveal} onOpen={onOpen} />
          ) : (
            <FileRow
              key={e.fileName}
              path={`${path}/${e.fileName}`}
              name={e.fileName}
              depth={depth}
              active={active}
              reveal={reveal}
              onOpen={onOpen}
            />
          ),
        )}
    </>
  );
}

function FileRow({
  path,
  name,
  depth,
  active,
  reveal,
  onOpen,
}: {
  path: string;
  name: string;
  depth: number;
  active: string | null;
  reveal: { path: string; seq: number; at: number } | null;
  onOpen: (p: string) => void;
}) {
  const row = useRef<HTMLButtonElement>(null);
  useEffectOn([reveal?.seq], () => {
    if (revealing(reveal) && reveal!.path === path) row.current?.scrollIntoView({ block: 'center', inline: 'nearest' });
  });
  return (
    <button
      ref={row}
      className={`file-node ${path === active ? 'active' : ''}`}
      aria-current={path === active || undefined}
      style={{ paddingLeft: 8 + depth * 14 + 13 }}
      onClick={() => onOpen(path)}
    >
      <LangIcon path={name} />
      <span className="file-node-name">{name}</span>
    </button>
  );
}
