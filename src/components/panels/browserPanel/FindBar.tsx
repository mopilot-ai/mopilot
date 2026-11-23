// The browser pane's find bar (⌘F with the page or pane focused, as Claude Desktop's and the ChatGPT app's): a term's
// matches through Chromium's find in the page (a <webview>'s own, main's for a view), ⌘G / ⇧⌘G or Enter / ⇧Enter between
// them, Esc to close; a navigation to another document closes it.
import { useRef, useState, type RefObject } from 'react';
import { ChevronDown, ChevronUp, Search, X } from '../../ui/icons';
import { useEffectOn } from '../../../lib/effects';
import { comboFromEvent } from '../../../lib/format';
import { cancelOnEscape } from '../../../lib/focus';
import { noteIgnored } from '../../../lib/ignored';
import { platform } from '../../../lib/platform';
import { toast, useStore } from '../../../store/core';
import { resolveShortcut } from '../../../../shared/shortcuts.mjs';
import type { WebviewElement } from '../../../session/useBrowserShortcuts';

export type FindAction = 'open' | 'next' | 'previous';
export interface PageFind {
  open: boolean;
  /** changes each time find is asked for while open: the field takes focus and selects its term */
  focusKey: number;
  query: string;
  /** the current match and how many the page has, once Chromium reported them for the term */
  count: { active: number; total: number } | null;
  command(action: FindAction): void;
  search(query: string): void;
  step(forward: boolean): void;
  close(): void;
}
interface FoundEvent extends Event {
  result?: { requestId?: number; activeMatchOrdinal?: number; matches?: number };
}

const ACTIONS: Record<string, FindAction> = { 'browser-find': 'open', 'browser-find-next': 'next', 'browser-find-previous': 'previous' };
/** The find action a key in the bar's field is bound to (the pane's own keys, rebindable in Settings), or null. */
export function findActionFor(e: Pick<KeyboardEvent, 'key' | 'code' | 'ctrlKey' | 'altKey' | 'shiftKey' | 'metaKey'>, bindings = {}) {
  const combo = comboFromEvent(e);
  const id = combo ? resolveShortcut(combo, bindings, 'browser', platform)?.id : undefined;
  return (id && ACTIONS[id]) || null;
}

/**
 * Find in the pane's page. `pageKey` names the page (a recreated one starts closed); the term stays for the next ⌘F, as
 * a browser's does.
 */
export function usePageFind(page: RefObject<WebviewElement | null>, pageKey: unknown): PageFind {
  const [open, setOpen] = useState(false);
  const [focusKey, setFocusKey] = useState(0);
  const [query, setQuery] = useState('');
  const [count, setCount] = useState<PageFind['count']>(null);
  // the term searched now ('' for none), and the first request whose results count: a new term's request makes any
  // earlier term's late results stale
  const live = useRef('');
  const floor = useRef(0);
  const failed = () => toast("Couldn't search this page", 'error');
  const reset = () => {
    setOpen(false);
    setCount(null);
    live.current = '';
  };
  const run = (text: string, forward: boolean, findNext: boolean) => {
    const p = page.current;
    live.current = text;
    if (!text) {
      setCount(null);
      return stop(p);
    }
    if (!p?.findInPage) return failed();
    try {
      Promise.resolve(p.findInPage(text, { forward, findNext })).then(
        (id) => {
          if (findNext && live.current === text && typeof id === 'number') floor.current = Math.max(floor.current, id);
        },
        () => page.current === p && failed(),
      );
    } catch {
      failed();
    }
  };
  const close = () => {
    if (!open) return;
    reset();
    stop(page.current);
  };
  const command = (action: FindAction) => {
    const p = page.current;
    // a tab with no page yet (the new tab's tools) has nothing to find
    if (!p) return;
    if (!p.findInPage) return toast("Find isn't available on this page", 'error');
    if (action === 'open' || !open || !query) {
      setOpen(true);
      setFocusKey((k) => k + 1);
      if (!open && query) run(query, true, true);
      return;
    }
    run(query, action === 'next', false);
  };
  // a recreated page numbers its requests from 1 again
  useEffectOn([pageKey], () => {
    reset();
    floor.current = 0;
  });
  // a recreated page (pageKey) is another element to hear
  useEffectOn([open, pageKey], () => {
    const p = page.current;
    if (!open || !p) return;
    const found = (e: Event) => {
      const r = (e as FoundEvent).result;
      if (!r || !live.current || (r.requestId ?? 0) < floor.current) return;
      setCount({ active: r.activeMatchOrdinal ?? 0, total: r.matches ?? 0 });
    };
    // another document (navigated): Chromium's find ended with the one it searched
    p.addEventListener('found-in-page', found);
    p.addEventListener('did-navigate', reset);
    return () => {
      p.removeEventListener('found-in-page', found);
      p.removeEventListener('did-navigate', reset);
    };
  });
  return {
    open,
    focusKey,
    query,
    count,
    command,
    search: (text) => {
      setQuery(text);
      run(text, true, true);
    },
    step: (forward) => query && run(query, forward, false),
    close,
  };
}

function stop(page: WebviewElement | null) {
  try {
    page?.stopFindInPage?.('clearSelection');
  } catch (error) {
    // a page that went has no find to end
    noteIgnored('end a find in a browser pane page', error);
  }
}

/** The bar while find is open; a closed one renders (and subscribes to) nothing. */
export function FindBar({ find }: { find: PageFind }) {
  return find.open ? <OpenFindBar find={find} /> : null;
}

function OpenFindBar({ find }: { find: PageFind }) {
  const input = useRef<HTMLInputElement>(null);
  const bindings = useStore((s) => s.prefs.keybindings);
  useEffectOn([find.focusKey], () => {
    input.current?.focus();
    input.current?.select();
  });
  const { count } = find;
  return (
    <div className="browser-find" role="search">
      <Search size={14} className="chat-find-icon" aria-hidden="true" />
      <input
        ref={input}
        className="chat-find-input"
        aria-label="Find in page"
        placeholder="Find in page"
        value={find.query}
        spellCheck={false}
        autoComplete="off"
        onChange={(e) => find.search(e.target.value)}
        onKeyDown={(e) => {
          if (e.nativeEvent.isComposing) return;
          // the pane's find keys work in the field too (the app's ⌘F would find in the chat)
          const action = findActionFor(e.nativeEvent, bindings);
          if (action) {
            e.preventDefault();
            find.command(action);
          } else if (e.key === 'Enter') {
            e.preventDefault();
            find.step(!e.shiftKey);
          } else cancelOnEscape(e, find.close);
        }}
      />
      <span className="chat-find-count" aria-live="polite">
        {find.query && count ? (count.total ? `${count.active} of ${count.total}` : 'No results') : ''}
      </span>
      <button
        type="button"
        className="icon-btn xs"
        aria-label="Previous match"
        title="Previous match"
        disabled={!count?.total}
        onClick={() => find.step(false)}
      >
        <ChevronUp size={14} />
      </button>
      <button
        type="button"
        className="icon-btn xs"
        aria-label="Next match"
        title="Next match"
        disabled={!count?.total}
        onClick={() => find.step(true)}
      >
        <ChevronDown size={14} />
      </button>
      <button type="button" className="icon-btn xs" aria-label="Close find bar" title="Close find bar" onClick={find.close}>
        <X size={14} />
      </button>
    </div>
  );
}
