// The turn navigation rail beside a thread: a mark per message, previews, bookmarks and loading older history.

import { visiblePoll } from '../../lib/visiblePoll';
import { memo, useCallback, useEffect, useId, useMemo, useRef, useState, type RefObject } from 'react';
import ReactMarkdown from 'react-markdown';
import { toggleNavigationBookmark, useStore } from '../../store/core';
import type { NavigationItem } from '../../session/threadNavigation';
import { useEffectOn } from '../../lib/effects';
import { adjacentMessage, navigationTops, useVisibleMessages } from './navigationVisibility';
import { Popover } from '../ui/Popover';
import { Bookmark, ChevronUp, FileDiff, Spinner } from '../ui/icons';
import { viewOwnsKey } from './approvalLogic';

const EMPTY_BOOKMARKS: string[] = [];
// Marks within this distance of the hovered or scrubbed one grow, as Codex's rail does. At rest every mark is the same length.
const NEIGHBOR_REACH = 3;
// A press becomes a scrub only past 4px of travel, so a mark clicked with a hand's jitter still opens its turn. Claude
// Desktop and the Codex app both start a drag at more than 4px (Claude 2.42304.2 ion-dist c427176b2 and six other
// modules; Codex app-shared link clicks).
const SCRUB_DEAD_ZONE = 4;
// Main chats and side chats share one document. A portal must not outlive its
// interaction when another view opens a navigation preview.
let dismissActivePreview: (() => void) | null = null;

/** Memoized: the thread keeps its entries' array and callbacks while a delta changes nothing the rail shows. */
export const TurnNavigation = memo(function TurnNavigation({
  threadId,
  items,
  scrollRef,
  inPane,
  hasOlder,
  loadingOlder,
  rendered,
  onLoadOlder,
  onNavigate,
}: {
  threadId: string;
  items: NavigationItem[];
  scrollRef: RefObject<HTMLDivElement | null>;
  inPane: boolean;
  hasOlder: boolean;
  loadingOlder: boolean;
  /** the turns the transcript renders in full (the rest are placeholders with no messages to observe) */
  rendered?: ReadonlySet<string>;
  onLoadOlder: () => Promise<void>;
  onNavigate: (id: string, instant?: boolean) => void;
}) {
  const focused = useStore((s) => s.focused);
  const saved = useStore((s) => s.navigationBookmarks[threadId] ?? EMPTY_BOOKMARKS);
  const bookmarks = useMemo(() => new Set(saved), [saved]);
  const [previewId, setPreviewId] = useState<string | null>(null);
  const [hoverId, setHoverId] = useState<string | null>(null);
  const rail = useRef<HTMLElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const preview = useRef<HTMLDivElement>(null);
  const buttons = useRef(new Map<string, HTMLButtonElement>());
  const openTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const clickTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const scrubFrame = useRef(0);
  const pointerY = useRef(0);
  const press = useRef<{ pointerId: number; button: HTMLButtonElement; startY: number; id: string; moved: boolean } | null>(null);
  const suppressClick = useRef(false);
  const keyboardFocus = useRef(false);
  const previewLabel = useId();
  const itemKey = items.map((i) => i.id).join('\n');

  const cancelTimers = useCallback(() => {
    if (openTimer.current) clearTimeout(openTimer.current);
    if (closeTimer.current) clearTimeout(closeTimer.current);
    openTimer.current = closeTimer.current = null;
  }, []);
  const close = useCallback(() => {
    cancelTimers();
    if (dismissActivePreview === close) dismissActivePreview = null;
    setPreviewId(null);
    setHoverId(null);
  }, [cancelTimers]);
  useEffect(() => {
    if (focused === false) close();
  }, [focused, close]);

  const show = (id: string, immediate = false) => {
    if (dismissActivePreview !== close) {
      dismissActivePreview?.();
      dismissActivePreview = close;
    }
    cancelTimers();
    setHoverId(id);
    if (immediate) setPreviewId(id);
    else
      openTimer.current = setTimeout(() => {
        openTimer.current = null;
        setPreviewId(id);
      }, 150);
  };
  const leave = useCallback(() => {
    if (press.current || closeTimer.current) return;
    cancelTimers();
    closeTimer.current = setTimeout(() => {
      closeTimer.current = null;
      // Tab can move from a mark into its bookmark button in the portal.
      // Pointer clicks also focus marks. Only keyboard focus should keep a preview open.
      if (keyboardFocus.current && (rail.current?.contains(document.activeElement) || preview.current?.contains(document.activeElement)))
        return;
      close();
    }, 180);
  }, [cancelTimers, close]);

  useEffect(
    () => () => {
      cancelTimers();
      if (dismissActivePreview === close) dismissActivePreview = null;
      cancelAnimationFrame(scrubFrame.current);
      if (clickTimer.current) clearTimeout(clickTimer.current);
    },
    [cancelTimers, close],
  );

  useEffect(() => {
    const scroll = scrollRef.current;
    const dismiss = () => {
      if (!press.current) close();
    };
    // A jump scrolls the transcript while the pointer is still on its mark. Hide the card but keep the mark
    // emphasized; the hover backstop clears it once the pointer is really gone.
    const onScroll = () => {
      if (press.current) return;
      cancelTimers();
      setPreviewId(null);
    };
    // Captured pointers and layout changes can skip the rail's pointerleave event.
    // Track movement across both the rail and the portalled preview as a fallback.
    const onPointerMove = (event: PointerEvent) => {
      if (!openTimer.current && !preview.current && !rail.current?.querySelector('.hovered')) return;
      keyboardFocus.current = false;
      const target = event.target as Node;
      if (rail.current?.contains(target) || preview.current?.contains(target)) {
        if (closeTimer.current) clearTimeout(closeTimer.current);
        closeTimer.current = null;
      } else leave();
    };
    const onPointerDown = (event: PointerEvent) => {
      keyboardFocus.current = false;
      const target = event.target as Node;
      if (!rail.current?.contains(target) && !preview.current?.contains(target)) close();
    };
    const onWindowBlur = () => {
      const current = press.current;
      press.current = null;
      list.current?.removeAttribute('data-scrubbing');
      cancelAnimationFrame(scrubFrame.current);
      scrubFrame.current = 0;
      if (current?.button.hasPointerCapture(current.pointerId)) current.button.releasePointerCapture(current.pointerId);
      close();
    };
    scroll?.addEventListener('scroll', onScroll, { passive: true });
    document.addEventListener('pointermove', onPointerMove, { passive: true });
    document.addEventListener('pointerdown', onPointerDown, true);
    window.addEventListener('blur', onWindowBlur);
    window.addEventListener('resize', dismiss);
    return () => {
      scroll?.removeEventListener('scroll', onScroll);
      document.removeEventListener('pointermove', onPointerMove);
      document.removeEventListener('pointerdown', onPointerDown, true);
      window.removeEventListener('blur', onWindowBlur);
      window.removeEventListener('resize', dismiss);
    };
  }, [scrollRef, close, leave, cancelTimers]);
  // another chat's transcript starts with no preview open
  useEffectOn([threadId], () => {
    close();
  });

  // Backstop for any missed pointerleave: while a hover or preview is showing, verify the pointer is really still over it.
  useEffect(() => {
    if (!hoverId && !previewId) return;
    const check = () => {
      if (press.current) return;
      const keyboardOver =
        keyboardFocus.current && (rail.current?.contains(document.activeElement) || preview.current?.contains(document.activeElement));
      if (keyboardOver) return;
      const over = [rail.current, preview.current].some((element) => element?.matches(':hover'));
      if (!over && !openTimer.current) close();
    };
    return visiblePoll('turn-navigation-hover', 250, check, { wake: false });
  }, [hoverId, previewId, close]);

  const activeIds = useVisibleMessages(scrollRef, itemKey, rendered);

  const activeId = items.find((item) => activeIds.has(item.id))?.id;
  useEffect(() => {
    if (!activeId || press.current || hoverId) return;
    const button = buttons.current.get(activeId);
    const container = list.current;
    if (!button || !container) return;
    const b = button.getBoundingClientRect(),
      c = container.getBoundingClientRect();
    if (b.top < c.top) container.scrollTop -= c.top - b.top;
    else if (b.bottom > c.bottom) container.scrollTop += b.bottom - c.bottom;
  }, [activeId, hoverId]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (
        event.defaultPrevented ||
        !event.altKey ||
        event.metaKey ||
        event.ctrlKey ||
        event.shiftKey ||
        !['ArrowUp', 'ArrowDown'].includes(event.key)
      )
        return;
      const scroll = scrollRef.current;
      if (!scroll || !scroll.clientHeight || !items.length) return;
      const target = event.target instanceof Element ? event.target : null;
      if (target?.closest('.popover-layer, [role="dialog"]')) return;
      if (!viewOwnsKey(target, scroll.closest('.thread-view'), inPane)) return;
      const top = scroll.getBoundingClientRect().top + (event.key === 'ArrowDown' ? 24 : 8);
      const tops = navigationTops(scroll, items);
      const index = adjacentMessage(tops, top, event.key === 'ArrowDown');
      const destination = items[index];
      if (!destination) return;
      event.preventDefault();
      close();
      onNavigate(destination.id);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [items, scrollRef, inPane, onNavigate, close]);

  const selected = items.find((item) => item.id === previewId);
  const hoverIndex = hoverId ? items.findIndex((item) => item.id === hoverId) : -1;
  const finishPress = (pointerId: number, x?: number, y?: number) => {
    const current = press.current;
    if (!current || current.pointerId !== pointerId) return;
    press.current = null;
    list.current?.removeAttribute('data-scrubbing');
    cancelAnimationFrame(scrubFrame.current);
    scrubFrame.current = 0;
    suppressClick.current = current.moved;
    if (current.button.hasPointerCapture(pointerId)) current.button.releasePointerCapture(pointerId);
    if (clickTimer.current) clearTimeout(clickTimer.current);
    clickTimer.current = setTimeout(() => {
      suppressClick.current = false;
    }, 0);
    // Pointer capture suppresses normal leave handling while dragging. Check the release position.
    if (x !== undefined && y !== undefined) {
      const inside = [rail.current, preview.current].some((element) => {
        const bounds = element?.getBoundingClientRect();
        return bounds && x >= bounds.left && x < bounds.right && y >= bounds.top && y < bounds.bottom;
      });
      if (!inside) {
        // A captured release can still dispatch click to the original mark outside the rail.
        suppressClick.current = true;
        leave();
      }
    }
  };
  const scrubAt = (y: number): void => {
    const current = press.current;
    const container = list.current;
    if (!current || !container) return;
    const bounds = container.getBoundingClientRect();
    const before = container.scrollTop;
    if (y < bounds.top + 12) container.scrollTop -= 4;
    if (y > bounds.bottom - 12) container.scrollTop += 4;
    const clampedY = Math.max(bounds.top, Math.min(bounds.bottom - 1, y));
    const candidates = [...buttons.current.entries()].filter(([, button]) => {
      const b = button.getBoundingClientRect();
      return b.bottom > bounds.top && b.top < bounds.bottom;
    });
    const nearest = candidates.reduce<(typeof candidates)[number] | null>((best, candidate) => {
      const distance = (button: HTMLButtonElement) => {
        const b = button.getBoundingClientRect();
        return Math.abs(clampedY - (b.top + b.bottom) / 2);
      };
      return !best || distance(candidate[1]) < distance(best[1]) ? candidate : best;
    }, null);
    if (nearest && (!current.moved || current.id !== nearest[0])) {
      current.id = nearest[0];
      current.moved = true;
      show(nearest[0], true);
      onNavigate(nearest[0], true);
    }
    cancelAnimationFrame(scrubFrame.current);
    scrubFrame.current = container.scrollTop !== before ? requestAnimationFrame(() => scrubAt(pointerY.current)) : 0;
  };
  if (items.length < 4 && !hasOlder && !items.some((i) => bookmarks.has(i.id))) return null;

  return (
    <>
      <nav
        className="turn-navigation"
        aria-label="Conversation messages"
        ref={rail}
        onKeyDownCapture={() => {
          keyboardFocus.current = true;
        }}
        onPointerDownCapture={() => {
          keyboardFocus.current = false;
        }}
        onPointerEnter={() => {
          keyboardFocus.current = false;
          cancelTimers();
        }}
        onPointerLeave={leave}
        onBlur={leave}
      >
        {hasOlder && (
          <button
            className="turn-navigation-older"
            disabled={loadingOlder}
            onClick={() => {
              close();
              void onLoadOlder();
            }}
            aria-label={loadingOlder ? 'Loading earlier messages' : 'Load earlier messages'}
            title="Load earlier messages"
          >
            {loadingOlder ? <Spinner size={13} /> : <ChevronUp size={14} />}
          </button>
        )}
        <div
          className="turn-navigation-list"
          ref={list}
          onWheel={close}
          onPointerMove={(event) => {
            const current = press.current;
            const container = list.current;
            if (!current || current.pointerId !== event.pointerId || !container) return;
            if (!(event.buttons & 1)) {
              finishPress(event.pointerId, event.clientX, event.clientY);
              return;
            }
            if (!current.moved && Math.abs(event.clientY - current.startY) <= SCRUB_DEAD_ZONE) return;
            event.preventDefault();
            pointerY.current = event.clientY;
            scrubAt(event.clientY);
          }}
          onPointerUp={(event) => finishPress(event.pointerId, event.clientX, event.clientY)}
          onPointerCancel={(event) => {
            finishPress(event.pointerId);
            close();
          }}
          onLostPointerCapture={(event) => finishPress(event.pointerId, event.clientX, event.clientY)}
        >
          {items.map((item, index) => (
            <button
              key={item.id}
              type="button"
              ref={(button) => {
                if (button) buttons.current.set(item.id, button);
                else buttons.current.delete(item.id);
              }}
              className={`turn-navigation-mark ${activeIds.has(item.id) ? 'current' : ''} ${hoverId === item.id ? 'hovered' : ''} ${bookmarks.has(item.id) ? 'bookmarked' : ''}`}
              data-neighbor-distance={
                hoverIndex >= 0 && Math.abs(index - hoverIndex) <= NEIGHBOR_REACH ? Math.abs(index - hoverIndex) : undefined
              }
              aria-label={`Jump to message ${index + 1}${bookmarks.has(item.id) ? ', bookmarked' : ''}: ${item.prompt.slice(0, 100)}`}
              aria-current={activeIds.has(item.id) ? 'true' : undefined}
              aria-controls={selected?.id === item.id ? previewLabel : undefined}
              onPointerEnter={() => {
                keyboardFocus.current = false;
                if (!press.current) show(item.id);
              }}
              onFocus={(event) => {
                keyboardFocus.current = event.currentTarget.matches(':focus-visible');
                if (keyboardFocus.current) show(item.id, true);
              }}
              onPointerDown={(event) => {
                if (event.button !== 0) return;
                press.current = {
                  pointerId: event.pointerId,
                  button: event.currentTarget,
                  startY: event.clientY,
                  id: item.id,
                  moved: false,
                };
                list.current?.setAttribute('data-scrubbing', '');
                event.currentTarget.setPointerCapture(event.pointerId);
              }}
              onKeyDown={(event) => {
                if (event.altKey || !['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return;
                event.preventDefault();
                const next =
                  event.key === 'Home'
                    ? 0
                    : event.key === 'End'
                      ? items.length - 1
                      : Math.max(0, Math.min(items.length - 1, index + (event.key === 'ArrowUp' ? -1 : 1)));
                buttons.current.get(items[next].id)?.focus();
              }}
              onClick={() => {
                if (suppressClick.current) {
                  suppressClick.current = false;
                  return;
                }
                close();
                // The pointer is still on this mark, so keep it emphasized until the pointer leaves.
                setHoverId(item.id);
                onNavigate(item.id);
              }}
            >
              <span className="turn-navigation-marker" aria-hidden="true">
                <span className="turn-navigation-marker-line" />
                {bookmarks.has(item.id) && <span className="turn-navigation-bookmark-dot" />}
              </span>
            </button>
          ))}
        </div>
      </nav>
      <Popover
        open={!!selected}
        anchor={previewId ? (buttons.current.get(previewId) ?? null) : null}
        onClose={close}
        placement="right-start"
        offset={4}
        className="turn-navigation-popover"
      >
        {selected && (
          <div
            className="turn-navigation-preview"
            ref={preview}
            id={previewLabel}
            role="group"
            aria-label="Message preview"
            onPointerEnter={() => {
              keyboardFocus.current = false;
              cancelTimers();
            }}
            onPointerLeave={leave}
            onKeyDownCapture={() => {
              keyboardFocus.current = true;
            }}
            onPointerDownCapture={() => {
              keyboardFocus.current = false;
            }}
            onFocusCapture={cancelTimers}
            onBlur={leave}
          >
            <div className="turn-navigation-preview-header">
              <button
                className="turn-navigation-prompt"
                title={selected.prompt}
                onClick={() => {
                  onNavigate(selected.id);
                  close();
                }}
              >
                {selected.prompt}
              </button>
              <button
                className="icon-btn xs"
                disabled={!selected.canBookmark}
                aria-pressed={bookmarks.has(selected.id)}
                aria-label={bookmarks.has(selected.id) ? 'Remove bookmark' : 'Bookmark message'}
                title={
                  selected.canBookmark
                    ? bookmarks.has(selected.id)
                      ? 'Remove bookmark'
                      : 'Bookmark message'
                    : 'Available once the message is recorded'
                }
                onClick={() => toggleNavigationBookmark(threadId, selected.id)}
              >
                <Bookmark size={15} fill={bookmarks.has(selected.id) ? 'currentColor' : 'none'} />
              </button>
            </div>
            {selected.response && (
              <div className="turn-navigation-response">
                <ReactMarkdown
                  components={{
                    a: ({ children }) => <span>{children}</span>,
                    img: ({ alt }) => <span>{alt || 'Image'}</span>,
                    pre: ({ children }) => <span>{children}</span>,
                  }}
                >
                  {selected.response.slice(0, 2000)}
                </ReactMarkdown>
              </div>
            )}
            {!!selected.outputs.length && (
              <div className="turn-navigation-outputs">
                <FileDiff size={13} />
                {selected.outputs.slice(0, 2).map((output) => (
                  <span key={output} title={output}>
                    {output}
                  </span>
                ))}
                {selected.outputs.length > 2 && <span>+{selected.outputs.length - 2}</span>}
              </div>
            )}
          </div>
        )}
      </Popover>
    </>
  );
});
