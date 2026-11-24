// The composer's popups: the "/" command menu and the "@" mention list (files and other chats), which one the caret
// opens (useComposerPopup), and the keyboard handling the composer forwards to them (a `composer-popup-key` event).
import { useChatMachine, useFolderHere } from '../../lib/chatMachine';
import { useRemoteSearch } from '../../lib/hostFileSearch';
import { useDeletionVisibility } from '../../store/useDeletionVisibility';
import { deletionVisibility } from '../../store/deletionVisibility';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useStore, threadTitle, toastFailure } from '../../store/core';
import { navigate } from '../../store/panes';
import { currentCwdForNewChat } from '../../store/projects';
import { searchThreads } from '../../store/connection';
import { canSelectChatSearch, mergeChatSearch } from '../../lib/chatSearch';
import { withKeys } from '../../lib/listKeys';
import { slashNames } from '../../harness/commands';
import { native } from '../../lib/native';
import type { Thread } from '../../store/types';
import { Popover } from '../ui/Popover';
import { Check, ChevronRight, FileText, Folder, MessageCircle } from '../ui/icons';
import { BrowserTabRows, useBrowserTabMentions, type BrowserTabOption } from './BrowserTabMentions';
import { errorText } from '../../lib/ignored';
import { composerPopup, type ComposerPopup, type ComposerSlashItem } from '../../lib/composerSkills';
import { byActivity } from '../../lib/chatActivity';

export function usePopupKeys(
  owner: HTMLElement | null,
  count: number,
  index: number,
  setIndex: (n: number) => void,
  onEnter: (index: number) => void,
) {
  const currentIndex = useRef(index);
  currentIndex.current = index;
  useEffect(() => {
    const h = (e: Event) => {
      const { key, owner: source } = (e as CustomEvent).detail;
      if (!count || !owner || source !== owner) return;
      e.preventDefault();
      const active = Math.min(Math.max(currentIndex.current, 0), count - 1);
      if (key === 'ArrowDown' || key === 'ArrowUp') {
        const next = (active + (key === 'ArrowDown' ? 1 : -1) + count) % count;
        currentIndex.current = next;
        setIndex(next);
      } else if (key === 'Enter') onEnter(active);
    };
    window.addEventListener('composer-popup-key', h);
    return () => window.removeEventListener('composer-popup-key', h);
  }, [owner, count, setIndex, onEnter]);
}

/** Entries of the "/" menu, in the official order. Items with `sub` open a list in the same panel. */
export interface SlashItem extends ComposerSlashItem {
  id: string;
  title: string;
  desc?: string;
  icon?: React.ReactNode;
  sub?: () => Promise<SlashItem[]> | SlashItem[];
  checked?: boolean;
  scope?: string;
}

export function SlashPopup({
  anchor,
  query,
  index,
  setIndex,
  items,
  footer,
  onDone,
  onClose,
}: {
  anchor: HTMLElement | null;
  query: string;
  index: number;
  setIndex: (n: number) => void;
  items: SlashItem[];
  /** shown under the list when some commands are left out */
  footer?: string;
  onDone: (item: SlashItem) => void;
  onClose: () => void;
}) {
  const [sub, setSub] = useState<SlashItem[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const submenuRequest = useRef(0);
  // A new query leaves the submenu and its error from its first frame, and drops a submenu still loading for the
  // old one: the request count moves here, not in an effect, so no answer lands between this render and its effects.
  const [shownFor, setShownFor] = useState(query);
  if (shownFor !== query) {
    setShownFor(query);
    setSub(null);
    setLoadError(null);
    submenuRequest.current++;
  }
  const panel = useRef<HTMLDivElement>(null);
  const q = query.toLowerCase();
  const list = sub ?? items.filter((c) => !q || slashNames(c).some((n) => n.startsWith(q)));
  const pick = async (it: SlashItem) => {
    if (it.disabled) return;
    const request = ++submenuRequest.current;
    setLoadError(null);
    if (it.sub) {
      try {
        const items = await it.sub();
        if (request !== submenuRequest.current) return;
        setSub(items);
        setIndex(0);
      } catch (error) {
        if (request === submenuRequest.current) setLoadError(`Could not load ${it.title}: ${errorText(error)}`);
      }
      return;
    }
    onDone(it);
  };
  usePopupKeys(anchor, list.length, index, setIndex, (selected) => {
    if (list[selected]) pick(list[selected]).catch(toastFailure("Couldn't run that"));
  });
  // a submenu still loading when the menu closes is dropped
  useEffect(
    () => () => {
      submenuRequest.current++;
    },
    [],
  );
  useEffect(() => {
    if (list.length && index >= list.length) setIndex(list.length - 1);
  }, [list.length, index, setIndex]);
  useLayoutEffect(() => {
    const container = panel.current;
    // only a row: past the end of a list that just got shorter is the footer, until the index is clamped
    const selected = index < list.length ? (container?.children[index] as HTMLElement | undefined) : undefined;
    if (!container || !selected) return;
    const row = selected.getBoundingClientRect();
    const bounds = container.getBoundingClientRect();
    if (row.top < bounds.top) container.scrollTop += row.top - bounds.top;
    else if (row.bottom > bounds.bottom) container.scrollTop += row.bottom - bounds.bottom;
  }, [index, list.length]);
  if (!list.length) return null;
  return (
    <Popover anchor={anchor} open onClose={onClose} placement="top-start" offset={4} matchWidth>
      <div ref={panel} className="add-panel slash-panel">
        {list.map((c, i) => (
          <button
            key={c.id}
            className={`add-panel-item ${i === index ? 'sel' : ''} ${c.disabled ? 'disabled' : ''}`}
            aria-disabled={!!c.disabled}
            title={c.disabled}
            onMouseMove={(e) => {
              if (e.movementX || e.movementY) setIndex(i);
            }}
            onMouseDown={(e) => {
              e.preventDefault();
              pick(c).catch(toastFailure("Couldn't run that"));
            }}
          >
            {c.icon && <span className="add-panel-icon">{c.icon}</span>}
            <span className="add-panel-title">{c.title}</span>
            {c.desc && <span className="add-panel-desc">{c.desc}</span>}
            {c.checked && <Check size={14} className="add-panel-check" />}
            {c.scope && <span className="add-panel-scope">{c.scope}</span>}
            {c.sub && <ChevronRight size={15} className="add-panel-chevron" />}
          </button>
        ))}
        {loadError && (
          <div className="add-panel-footer" role="alert">
            {loadError}
          </div>
        )}
        {footer && !sub && (
          <button
            className="add-panel-footer"
            onMouseDown={(e) => {
              e.preventDefault();
              onClose();
              navigate({ name: 'settings', section: 'harnesses' });
            }}
          >
            {footer}
          </button>
        )}
      </div>
    </Popover>
  );
}

/** Chats the @ list offers for a bare "@", and while a term is typed (Claude Desktop's 3 and 8, #1931). */
export const MENTION_CHATS_EMPTY = 3;
export const MENTION_CHATS_TYPING = 8;

export function MentionPopup({
  anchor,
  threadId,
  query,
  index,
  setIndex,
  onPick,
  onPickChat,
  onPickTab,
  onClose,
}: {
  anchor: HTMLElement | null;
  threadId: string | null;
  query: string;
  index: number;
  setIndex: (n: number) => void;
  onPick: (p: string, isDir: boolean) => void;
  onPickChat: (t: Thread) => void;
  onPickTab: (t: BrowserTabOption) => void;
  onClose: () => void;
}) {
  useDeletionVisibility();
  // a chat on a machine has no folder to search here: its files are searched on the machine, through its Host
  const chatCwd = useStore((s) => (threadId ? s.threads[threadId]?.cwd : null) || currentCwdForNewChat());
  // a new chat with a machine and folder picked in the host chip searches that folder there too: its own folder is not this Mac's
  // (the pick holds only while no project or folder here was picked after it: store/projects.ts newChatHostPick)
  const pick = useStore((s) => (!threadId && s.newChatProjectId === null && s.newChatCwd === null ? s.newChatHost : null));
  const chatMachine = useChatMachine(threadId).machine;
  const machine = chatMachine ?? (pick ? { id: pick.id, name: pick.name, away: false } : null);
  const folder = pick ? pick.path : chatCwd;
  const cwd = useFolderHere(threadId, machine ? '' : chatCwd);
  const remoteFiles = useRemoteSearch(machine && !machine.away ? machine.id : null, folder, query);
  type FileResult = { path: string; file_name: string; match_type?: string; indices: number[] | null };
  const [fileResults, setFileResults] = useState<{ query: string; cwd: string; files: FileResult[] } | null>(null);
  const localResults = fileResults?.query === query && fileResults.cwd === cwd ? fileResults.files : [];
  // what the machine found, in the shape of a local result; its paths are relative to the chat's folder
  const results: FileResult[] =
    machine && remoteFiles.state === 'ready'
      ? remoteFiles.files.map((path) => ({ path, file_name: path.slice(path.lastIndexOf('/') + 1), indices: null }))
      : machine
        ? []
        : localResults;
  // one line when the machine has not answered or cannot: never this Mac's results in their place
  const note = !machine
    ? null
    : machine.away
      ? `Can't search ${machine.name}`
      : remoteFiles.state === 'searching'
        ? `Searching on ${machine.name}…`
        : remoteFiles.state === 'unavailable'
          ? `Can't search ${machine.name}`
          : null;
  const threads = useStore((s) => s.threads);
  const initialTitles = useStore((s) => s.chatInitialTitles);
  const order = useStore((s) => s.threadOrder);
  const archived = useStore((s) => s.claudeArchived);
  const segments = useStore((s) => s.segments);
  const momoChats = useStore((s) => s.momoChats);
  const [remote, setRemote] = useState<{ query: string; sources: Awaited<ReturnType<typeof searchThreads>> } | null>(null);
  // Resolve aliases before excluding the active canonical chat and applying the result limit.
  const chats = mergeChatSearch({
    ...deletionVisibility.sources({
      local: order
        .filter((id) => id !== threadId)
        .map((id) => threads[id])
        .filter(Boolean)
        .sort(byActivity),
      ...(remote?.query === query ? remote.sources : {}),
    }),
    archived,
    segments,
    knownChats: threads,
    excluded: (id) => id === threadId || deletionVisibility.has(id),
    momoChats,
    titleOf: (thread) => threadTitle(thread, initialTitles),
    term: query,
    // as Claude Desktop's @ menu (#1931): 3 recent chats for a bare "@", 8 while typing, matched on their title
    limit: query.trim() ? MENTION_CHATS_TYPING : MENTION_CHATS_EMPTY,
    titleOnly: true,
  });
  const canPick = (id: string) => {
    const current = useStore.getState();
    const sources = remote?.query === query ? remote.sources : null;
    return canSelectChatSearch(
      id,
      {
        segments: current.segments,
        knownChats: current.threads,
        archived: current.claudeArchived,
        excluded: (key) => key === threadId || deletionVisibility.has(key),
        momoChats: current.momoChats,
      },
      [...(sources?.codex ?? []), ...(sources?.claude ?? []), ...(sources?.sage ?? [])],
    );
  };
  useEffect(() => {
    let alive = true;
    const t = setTimeout(async () => {
      try {
        if (!cwd) return void (alive && setFileResults({ query, cwd, files: [] }));
        const r = await native.search.files(cwd, query, { limit: 12 });
        if (alive) setFileResults({ query, cwd, files: r.files });
      } catch {
        if (alive) setFileResults({ query, cwd, files: [] });
      }
    }, 60);
    return () => {
      alive = false;
      clearTimeout(t);
    };
  }, [query, cwd]);
  useEffect(() => {
    if (!query.trim()) {
      setRemote(null);
      return;
    }
    let alive = true;
    const timer = setTimeout(() => {
      searchThreads(query.trim(), 'mentions').then(
        (sources) => {
          if (alive) setRemote({ query, sources });
        },
        () => {
          /* local chat matches remain visible when remote search fails */
        },
      );
    }, 120);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [query]);
  // the chat's browser tabs come first: rows 0…tabs.length-1
  const tabs = useBrowserTabMentions(threadId, query);
  const count = tabs.length + results.length + chats.length;
  useEffect(() => {
    if (index >= count) setIndex(0);
  }, [count, index, setIndex]);
  usePopupKeys(anchor, count, index, setIndex, (selected) => {
    const tab = tabs[selected];
    const chat = chats[selected - tabs.length];
    const file = results[selected - tabs.length - chats.length];
    if (tab) onPickTab(tab);
    else if (file) onPick(file.path, file.match_type === 'directory');
    else if (chat && canPick(chat.id)) onPickChat(chat);
  });
  if (!count && !note) return null;
  return (
    <Popover anchor={anchor} open onClose={onClose} placement="top-start" matchWidth>
      <div className="menu composer-popup">
        <BrowserTabRows tabs={tabs} index={index} setIndex={setIndex} onPick={onPickTab} />
        {chats.map((t, i) => {
          return (
            <div
              key={`chat:${t.id}`}
              className={`menu-item ${tabs.length + i === index ? 'kbd-active' : ''}`}
              onMouseMove={() => setIndex(tabs.length + i)}
              onMouseDown={(e) => {
                e.preventDefault();
                if (canPick(t.id)) onPickChat(t);
              }}
            >
              <span className="menu-icon">
                <MessageCircle size={15} />
              </span>
              <span className="mention-name">{threadTitle(t, initialTitles)}</span>
            </div>
          );
        })}
        {results.map((r, i) => (
          <div
            key={r.path}
            className={`menu-item ${tabs.length + chats.length + i === index ? 'kbd-active' : ''}`}
            onMouseMove={() => setIndex(tabs.length + chats.length + i)}
            onMouseDown={(e) => {
              e.preventDefault();
              onPick(r.path, r.match_type === 'directory');
            }}
          >
            <span className="menu-icon">{r.match_type === 'directory' ? <Folder size={15} /> : <FileText size={15} />}</span>
            <span className="mention-name">{highlight(r.file_name, r.indices, r.path.length - r.file_name.length)}</span>
            <span className="mention-path">{r.path}</span>
          </div>
        ))}
        {note && (
          <div className="menu-item mention-note" role="status" aria-disabled="true">
            {note}
          </div>
        )}
      </div>
    </Popover>
  );
}

/** The file name with the matched characters bold: `indices` are UTF-16 offsets in the path (electron/platform/search.cjs). */
export function highlight(name: string, indices: number[] | null, offset: number) {
  if (!indices?.length) return name;
  const set = new Set(indices.map((i) => i - offset));
  // each character (an emoji is two UTF-16 units) is bold when a matched offset falls in it
  let at = 0;
  const chars = [...name].map((ch) => {
    const start = at;
    at += ch.length;
    return { ch, bold: set.has(start) || (ch.length > 1 && set.has(start + 1)) };
  });
  // a name is fixed text: a letter and how many times it came before is its place
  return withKeys(chars, (c) => c.ch).map(({ key, item }) => (item.bold ? <b key={key}>{item.ch}</b> : <span key={key}>{item.ch}</span>));
}

/**
 * The open popup and its highlighted row. `updatePopup` follows the text and the caret; `markApplied` records a file
 * mention the @ list inserted, so the caret moving after it does not reopen the list on it (composerPopup).
 */
export function useComposerPopup() {
  const [popup, setPopup] = useState<ComposerPopup | null>(null);
  const [popupIndex, setPopupIndex] = useState(0);
  // every file mention this composer inserted (a few per message): an edit before one moves it, and the caret can
  // come back to any of them
  const applied = useRef<string[]>([]);
  const updatePopup = (value: string, caret: number) => {
    const next = composerPopup(value, caret, applied.current);
    setPopup(next);
    if (next) setPopupIndex(0);
  };
  const markApplied = (token: string) => {
    if (!applied.current.includes(token)) applied.current.push(token);
  };
  return { popup, setPopup, popupIndex, setPopupIndex, updatePopup, markApplied };
}
