// The search palette: chats (local and each harness's), quick actions and Settings entries, or files in files mode.
import { selectLocalProject } from '../../store/localProjectDraft';
import { useDeletionVisibility } from '../../store/useDeletionVisibility';
import { deletionVisibility } from '../../store/deletionVisibility';
import { useShortcutHint } from '../../session/shortcutHints';

import { shortcutLabel } from '../../lib/platform';
import { cancelOnEscape } from '../../lib/focus';
import { useEffect, useRef, useState } from 'react';
import { useEffectOn } from '../../lib/effects';
import { SECTIONS } from '../pages/Settings';
import { useStore, set as setState, threadTitle } from '../../store/core';
import { navigate } from '../../store/panes';
import { projectForThread, createProject, currentCwdForNewChat } from '../../store/projects';
import { searchThreads } from '../../store/connection';
import { clearNewChatProject } from '../../store/chats';
import { native } from '../../lib/native';
import { canSelectChatSearch, mergeChatSearch } from '../../lib/chatSearch';
import { SquarePen, FolderOpen, FileSearch, FileText, MessageSquare } from '../ui/icons';
import { MenuRow, useListbox } from '../ui/MenuList';
import { errorText } from '../../lib/ignored';
import { openFile } from '../../session/open';

interface Entry {
  id: string;
  section: string;
  icon?: React.ReactNode;
  title: string;
  sub?: string;
  right?: string;
  external?: boolean;
  run: () => void;
  canRun?: () => boolean;
}

// Settings entries follow the Settings navigation order (as in the official palette).
const SETTINGS: [string, string, React.ReactNode, boolean?][] = SECTIONS.map((x) => [x.id, x.label, x.icon, x.external]);

/** Mounted for the app's life but reading only `searchOpen`: the body (every chat merged and filtered per store write) exists while open. */
export function SearchPalette() {
  return useStore((s) => s.searchOpen) ? <SearchPaletteBody /> : null;
}

function SearchPaletteBody() {
  useDeletionVisibility();
  const shortcut = useShortcutHint();
  const mode = useStore((s) => s.searchMode);
  const threads = useStore((s) => s.threads);
  const initialTitles = useStore((s) => s.chatInitialTitles);
  const order = useStore((s) => s.threadOrder);
  const projects = useStore((s) => s.savedProjects);
  const [q, setQ] = useState('');
  const archivedAt = useStore((s) => s.claudeArchived);
  const segments = useStore((s) => s.segments);
  const momoChats = useStore((s) => s.momoChats);
  const cwd = useStore(() => currentCwdForNewChat());
  const ownerCwd = mode === 'files' ? cwd : '';
  const [result, setResult] = useState<{
    query: string;
    mode: typeof mode;
    cwd: string;
    remote: Awaited<ReturnType<typeof searchThreads>> | null;
    files: Awaited<ReturnType<typeof native.search.files>>['files'];
    error: string | null;
  } | null>(null);
  // Retire selectable hits and failures in the render that changes owner, before debounce or effect cleanup.
  const current = result?.query === q && result.mode === mode && result.cwd === ownerCwd ? result : null;
  const remote = current?.remote;
  const files = current?.files ?? [];
  const searchError = current?.error;
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setResult(null);
    if (!q.trim()) {
      return;
    }
    // Results always belong to the current query: a failed search shows none and says it failed, and an
    // answer that arrives after the query changed is dropped.
    let live = true;
    const t = setTimeout(async () => {
      if (mode === 'files') {
        const r = await native.search.files(ownerCwd, q, { limit: 40, dirs: false }).then(
          (found) => ({ files: found.files, error: null }),
          (e: unknown) => ({ files: [], error: `Couldn't search files: ${errorText(e)}` }),
        );
        if (!live) return;
        setResult({ query: q, mode, cwd: ownerCwd, remote: null, files: r.files, error: r.error });
        return;
      }
      // the chats loaded here still match; only the harnesses' own search is missing
      const r = await searchThreads(q.trim(), 'palette').then(
        (found) => ({ found, error: null }),
        (e: unknown) => ({ found: null, error: `Couldn't search older chats: ${errorText(e)}` }),
      );
      if (!live) return;
      setResult({ query: q, mode, cwd: ownerCwd, remote: r.found, files: [], error: r.error });
    }, 120);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [q, mode, ownerCwd]);

  const close = () => setState({ searchOpen: false, searchMode: 'all' });

  const entries: Entry[] = (() => {
    if (mode === 'files')
      return files.map((f) => ({
        id: f.path,
        section: 'Files',
        icon: <FileText size={15} strokeWidth={1.6} />,
        title: f.file_name,
        sub: f.path,
        run: () => openFile(`${f.root}/${f.path}`),
      }));
    const ql = q.trim().toLowerCase();
    const local = order.map((id) => threads[id]).filter((t) => t && !t.ephemeral && !t.parentThreadId);
    const pool = mergeChatSearch({
      ...deletionVisibility.sources({ local, ...(ql ? (remote ?? {}) : {}) }),
      archived: archivedAt,
      segments,
      knownChats: threads,
      excluded: (id) => deletionVisibility.has(id),
      momoChats,
      titleOf: (thread) => threadTitle(thread, initialTitles),
      term: ql,
      limit: ql ? 20 : 5,
    });
    const canPick = (id: string) => {
      const current = useStore.getState();
      return canSelectChatSearch(
        id,
        {
          segments: current.segments,
          knownChats: current.threads,
          archived: current.claudeArchived,
          excluded: (key) => deletionVisibility.has(key),
          momoChats: current.momoChats,
        },
        [...(remote?.codex ?? []), ...(remote?.claude ?? []), ...(remote?.sage ?? [])],
      );
    };
    const chats: Entry[] = pool.map((t) => ({
      id: t.id,
      section: 'Chats',
      canRun: () => canPick(t.id),
      icon: <MessageSquare size={15} strokeWidth={1.6} />,
      title: threadTitle(t, initialTitles),
      sub: projectForThread(t, projects)?.name,
      run: () => {
        if (!canPick(t.id)) return;
        // a hit the window has not loaded yet (past the sidebar's pages): known, but not in the list
        if (!useStore.getState().threads[t.id]) setState({ threads: { ...useStore.getState().threads, [t.id]: t } });
        navigate({ name: 'thread', id: t.id });
      },
    }));
    const actions: Entry[] = [
      {
        id: 'a-new',
        section: 'Quick actions',
        icon: <SquarePen size={15} strokeWidth={1.6} />,
        title: 'New chat',
        right: shortcut('new-chat'),
        run: () => {
          clearNewChatProject(true);
          navigate({ name: 'home' });
        },
      },
      {
        id: 'a-folder',
        section: 'Quick actions',
        icon: <FolderOpen size={15} strokeWidth={1.6} />,
        title: 'Open folder',
        right: shortcut('open-folder'),
        run: async () => {
          const p = await native.dialog.openFolder();
          if (p) {
            const id = await createProject(p);
            if (id) selectLocalProject(id);
            navigate({ name: 'home', cwd: p });
          }
        },
      },
      {
        id: 'a-files',
        section: 'Quick actions',
        icon: <FileSearch size={15} strokeWidth={1.6} />,
        title: 'Search files',
        right: shortcut('search-files'),
        run: () => setTimeout(() => setState({ searchOpen: true, searchMode: 'files' }), 0),
      },
    ];
    const settings: Entry[] = SETTINGS.map(([id, title, icon, external]) => ({
      id: 's-' + id,
      section: 'Settings',
      icon,
      title,
      external,
      run: () => (id === 'plugins' ? navigate({ name: 'plugins' }) : navigate({ name: 'settings', section: id })),
    }));
    const filt = (e: Entry) => !ql || e.title.toLowerCase().includes(ql);
    return [...chats, ...actions.filter(filt), ...settings.filter(filt)];
  })();

  const box = useListbox(entries.length, (i) => {
    if (entries[i].canRun?.() === false) return;
    close();
    entries[i].run();
  });
  const { index: idx, setIndex: setIdx } = box;

  // Switching the palette to another mode starts over: no frame shows the last search.
  const [shownFor, setShownFor] = useState(mode);
  if (shownFor !== mode) {
    setShownFor(mode);
    setQ('');
    setIdx(0);
    setResult(null);
  }
  // focus the field when the palette opens and again when it switches mode
  useEffectOn([mode], () => {
    const frame = requestAnimationFrame(() => inputRef.current?.focus());
    return () => cancelAnimationFrame(frame);
  });

  useEffect(() => {
    listRef.current?.querySelectorAll('.palette-item')[idx]?.scrollIntoView({ block: 'nearest' });
  }, [idx]);

  let lastSection = '';
  return (
    <div className="palette-backdrop" onMouseDown={close}>
      <div className="palette" onMouseDown={(e) => e.stopPropagation()}>
        <input
          ref={inputRef}
          className="palette-input"
          placeholder={mode === 'files' ? 'Search files' : 'Search chats'}
          value={q}
          onChange={(e) => {
            setQ(e.target.value);
            setIdx(0);
          }}
          aria-label={mode === 'files' ? 'Search files' : 'Search chats'}
          {...box.field}
          onKeyDown={(e) => {
            if (!cancelOnEscape(e, close)) box.field.onKeyDown(e);
          }}
        />
        <div className="palette-list" ref={listRef} id={box.listId} role="listbox" aria-label="Results">
          {searchError && (
            <div className="palette-empty" role="alert">
              {searchError}
            </div>
          )}
          {entries.length === 0 && !searchError && (
            <div className="palette-empty">{mode === 'files' && !q ? 'Type to search files' : 'No results'}</div>
          )}
          {entries.map((en, i) => {
            const head = en.section !== lastSection ? en.section : null;
            lastSection = en.section;
            return (
              <div key={en.id} role="none">
                {head && (
                  <div className="palette-section" role="presentation">
                    {head}
                  </div>
                )}
                <MenuRow
                  bare
                  className={`palette-item ${i === idx ? 'sel' : ''}`}
                  {...box.option(i)}
                  onMouseMove={() => setIdx(i)}
                  onClick={() => {
                    if (en.canRun?.() === false) return;
                    close();
                    en.run();
                  }}
                >
                  <span className="palette-icon">{en.icon}</span>
                  <span className="palette-title">{en.title}</span>
                  {en.sub && <span className="palette-sub">{en.sub}</span>}
                  {en.right && <span className="palette-right">{shortcutLabel(en.right)}</span>}
                </MenuRow>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
