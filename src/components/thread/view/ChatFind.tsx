// The chat's find bar (⌘F, Edit → Find in Chat): a term's matches in the prompts and replies of the loaded turns on
// every harness, the current one scrolled to and set apart, Enter / ⇧Enter between them, and earlier history on request.
import { useEffect, useEffectEvent, useMemo, useReducer, useRef, useState, type RefObject } from 'react';
import type { TurnState } from '../../../store/types';
import { chatFindMatches, firstMatch, foldTerm, stepMatch, type ChatFindMatch } from '../../../session/chatFind';
import { useEffectOn } from '../../../lib/effects';
import { ChevronDown, ChevronUp, Search, X } from '../../ui/icons';
import { findRanges, showFindHighlights } from './chatFindRanges';

type MatchKey = Pick<ChatFindMatch, 'turnId' | 'ordinal'>;
const same = (m: ChatFindMatch, p: MatchKey | null) => !!p && m.turnId === p.turnId && m.ordinal === p.ordinal;

export function ChatFind({
  turns,
  scrollRef,
  hasOlder,
  loadingOlder,
  focusKey,
  onNavigate,
  onLoadOlder,
  onClose,
}: {
  turns: TurnState[];
  scrollRef: RefObject<HTMLElement | null>;
  hasOlder: boolean;
  loadingOlder: boolean;
  /** changes each time find is asked for again while open: the field takes focus and selects its term */
  focusKey: number;
  /** jump to a navigation entry, rendering its turn (ThreadView's navigateTo; `instant`: no smooth scroll) */
  onNavigate: (entryId: string, instant: boolean) => void;
  /** load a page of earlier history (ThreadView's requestOlder) */
  onLoadOlder: () => Promise<void>;
  onClose: () => void;
}) {
  const [term, setTerm] = useState('');
  const needle = foldTerm(term);
  // what each turn on screen draws, so the count is what is highlighted; a placeholder turn counts its data
  const [drawn, setDrawn] = useState<ReadonlyMap<string, number>>(new Map());
  const matches = useMemo(() => chatFindMatches(turns, needle, drawn), [turns, needle, drawn]);
  // the current match by what it is, so a streamed reply or a page of older history keeps it; one its turn no longer
  // draws (fewer on screen than its data held) falls back to the turn's last
  const [pick, setPick] = useState<MatchKey | null>(null);
  const found = matches.findIndex((m) => same(m, pick));
  const inTurn = found < 0 && pick ? matches.findLastIndex((m) => m.turnId === pick.turnId) : -1;
  const index = found >= 0 ? found : inTurn >= 0 ? inTurn : firstMatch(matches);
  const current = index >= 0 ? matches[index] : null;
  // the current match is scrolled to once it is rendered
  const reveal = useRef(false);
  const [, repaint] = useReducer((n: number) => n + 1, 0);
  const input = useRef<HTMLInputElement>(null);
  const owner = useRef({});

  const go = (m: ChatFindMatch | null) => {
    setPick(m && { turnId: m.turnId, ordinal: m.ordinal });
    reveal.current = !!m;
  };
  // a new term starts at its newest match
  useEffectOn([needle], () => {
    go(matches[firstMatch(matches)] ?? null);
  });
  const step = (by: 1 | -1) => go(matches[stepMatch(matches.length, index, by)] ?? null);

  // a match in a turn the window shows as a placeholder: jump there first, which renders it
  useEffectOn([pick], () => {
    if (current?.entryId && reveal.current && !drawn.has(current.turnId)) onNavigate(current.entryId, true);
  });

  const paint = useEffectEvent(() => {
    const scroll = scrollRef.current;
    if (!scroll) return;
    const byTurn = findRanges(scroll, needle);
    const counts = new Map([...byTurn].map(([id, list]) => [id, list.length]));
    if (counts.size !== drawn.size || [...counts].some(([id, n]) => drawn.get(id) !== n)) setDrawn(counts);
    const mine = current ? byTurn.get(current.turnId) : undefined;
    const range = mine?.[Math.min(current!.ordinal, mine.length - 1)] ?? null;
    showFindHighlights(owner.current, { all: [...byTurn.values()].flat(), current: range });
    if (!range || !reveal.current) return;
    // a long prompt folded behind Show more: unfold it, and go there once it has
    const more = range.startContainer.parentElement?.closest('.fold-text.clamped')?.nextElementSibling;
    if (more instanceof HTMLElement && more.matches('.fold-more')) return more.click();
    reveal.current = false;
    // a frame on: a jump that rendered the turn goes to its prompt in this commit's later effects (messageJumps.ts)
    requestAnimationFrame(() => {
      if (!range.startContainer.isConnected) return;
      const box = scroll.getBoundingClientRect();
      const at = range.getBoundingClientRect();
      // the bar sits over the transcript's top
      if (at.top < box.top + 56 || at.bottom > box.bottom - 24) scroll.scrollTop += at.top - box.top - box.height / 3;
    });
  });
  useEffect(() => paint());
  // turns render and stream without this view rendering again: paint once a frame while they change
  useEffect(() => {
    const scroll = scrollRef.current;
    if (!scroll) return;
    let frame = 0;
    const observer = new MutationObserver(() => {
      if (!frame) frame = requestAnimationFrame(() => ((frame = 0), paint()));
    });
    observer.observe(scroll, { subtree: true, childList: true, characterData: true });
    return () => {
      observer.disconnect();
      cancelAnimationFrame(frame);
    };
  }, [scrollRef]);
  useEffect(() => () => showFindHighlights(owner.current, null), []);
  // a page of earlier history keeps the place of the last jump (its prompt): the current match is gone to again
  const loadOlder = () =>
    void onLoadOlder().then(() => {
      reveal.current = !!current;
      repaint();
    });

  useEffectOn([focusKey], () => {
    input.current?.focus();
    input.current?.select();
  });

  return (
    <div className="chat-find" role="search">
      <Search size={14} className="chat-find-icon" aria-hidden="true" />
      <input
        ref={input}
        className="chat-find-input"
        aria-label="Find in chat"
        placeholder="Find in chat"
        value={term}
        spellCheck={false}
        onChange={(e) => setTerm(e.target.value)}
        onKeyDown={(e) => {
          if (e.nativeEvent.isComposing) return;
          if (e.key === 'Enter') {
            e.preventDefault();
            step(e.shiftKey ? -1 : 1);
          } else if (e.key === 'Escape') {
            e.preventDefault();
            onClose();
          }
        }}
      />
      <span className="chat-find-count" aria-live="polite">
        {needle ? (matches.length ? `${index + 1} of ${matches.length}` : 'No results') : ''}
      </span>
      {hasOlder && (
        // only the loaded turns are searched: earlier history comes a page at a time
        <button type="button" className="chat-find-older" disabled={loadingOlder} onClick={loadOlder}>
          {loadingOlder ? 'Loading…' : 'Search earlier'}
        </button>
      )}
      <button type="button" className="icon-btn xs" aria-label="Previous match" disabled={!matches.length} onClick={() => step(-1)}>
        <ChevronUp size={14} />
      </button>
      <button type="button" className="icon-btn xs" aria-label="Next match" disabled={!matches.length} onClick={() => step(1)}>
        <ChevronDown size={14} />
      </button>
      <button type="button" className="icon-btn xs" aria-label="Close find" onClick={onClose}>
        <X size={14} />
      </button>
    </div>
  );
}

/**
 * Whether this view's find bar is open, and the key that focuses it again: ⌘F for the chat opens it in the view holding
 * focus, else the window's first view of the chat; another chat in the view closes it. Closing gives focus back.
 */
export function useChatFindRequest(threadId: string, scrollRef: RefObject<HTMLElement | null>) {
  const [open, setOpen] = useState<{ chat: string; key: number; back: HTMLElement | null } | null>(null);
  useEffect(() => {
    const onFind = (event: Event) => {
      if ((event as CustomEvent<{ threadId?: string }>).detail?.threadId !== threadId) return;
      const mine = scrollRef.current?.closest('.thread-view');
      // a view hidden behind another (the side pane in full view) is not where find can show
      const views = [...document.querySelectorAll<HTMLElement>('.thread-view')].filter(
        (v) => v.dataset.threadId === threadId && !v.closest('[hidden]'),
      );
      const focused = document.activeElement?.closest<HTMLElement>('.thread-view');
      if (!mine || mine !== (focused && views.includes(focused) ? focused : views[0])) return;
      // nothing focused (the page itself) gives focus to the transcript on close
      const active =
        document.activeElement instanceof HTMLElement && document.activeElement !== document.body ? document.activeElement : null;
      setOpen((o) => ({
        chat: threadId,
        key: (o?.key ?? 0) + 1,
        back: o?.chat === threadId ? o.back : active?.closest('.chat-find') ? null : active,
      }));
    };
    window.addEventListener('find-in-chat', onFind);
    return () => window.removeEventListener('find-in-chat', onFind);
  }, [threadId, scrollRef]);
  // a view that shows another chat (a side pane's tab) closes find, so coming back finds it closed
  useEffectOn([threadId], () => {
    setOpen((o) => (o && o.chat !== threadId ? null : o));
  });
  const shown = open?.chat === threadId ? open : null;
  const close = () => {
    setOpen(null);
    const back = shown?.back;
    (back?.isConnected ? back : scrollRef.current)?.focus();
  };
  return { focusKey: shown?.key ?? null, close };
}
