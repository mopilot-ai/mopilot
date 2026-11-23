// Split view in the main area, as Claude Desktop's Code tab lays it out: the primary pane (the route's page) and each
// split pane's chat side by side in resizable columns, the focused one outlined. A click or focus in a pane focuses it.

import { useEffect, useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';
import { frameCoalescer, lockEdgeDrag } from '../../lib/edgeDrag';
import { applySplitOp, setSplitRoom } from '../../store/splitView';
import { useStore } from '../../store/core';
import { dragWeights, gridColumns, keyWeights, splitRoom } from '../../session/splitWeights';
import { ErrorBoundary } from '../ui/ErrorBoundary';
import { ThreadView } from '../thread/ThreadView';
import { SplitPaneHead } from './SplitPaneHead';
import { useSplitDrop } from './useSplitDrop';

/** A pane's root: a pointer or focus inside it makes it the focused pane. `focused` null: the window's only pane. */
function Pane({
  target,
  focused,
  label,
  inert,
  children,
}: {
  target: string;
  focused: boolean | null;
  label: string;
  inert?: boolean;
  children: ReactNode;
}) {
  const focus = () => {
    if (focused === false) applySplitOp({ op: 'focus', target });
  };
  return (
    <section
      className="split-pane"
      data-split-target={target}
      aria-label={label}
      data-focused={focused ?? undefined}
      inert={inert}
      onPointerDownCapture={focus}
      onFocusCapture={focus}
    >
      {children}
    </section>
  );
}

/** The separator between column `at` and the next: drag it, or move it with the arrow keys. */
function Separator({ at, weights, width, onLive }: { at: number; weights: number[]; width: number; onLive: (w: number[] | null) => void }) {
  const press = useRef<{ id: number; x: number; base: number[]; live: number[]; unlock: () => void } | null>(null);
  // a move paints once per frame, not once per pointer event: each one renders every pane's chat (#2049)
  const [frames] = useState(() => frameCoalescer(onLive));
  // a separator that goes mid-drag (its pane closed) leaves no drag widths behind for the next layout
  useEffect(
    () => () => {
      frames.cancel();
      press.current?.unlock();
      if (press.current) onLive(null);
    },
    [frames, onLive],
  );
  const finish = (id: number, keep: boolean) => {
    const p = press.current;
    if (!p || p.id !== id) return;
    press.current = null;
    frames.cancel();
    p.unlock();
    onLive(null);
    if (keep && p.live !== p.base) applySplitOp({ op: 'resize', weights: p.live });
  };
  return (
    <div
      className="split-sep"
      role="separator"
      aria-label="Resize pane columns"
      aria-orientation="vertical"
      aria-valuenow={Math.round((weights[at] / weights.reduce((a, w) => a + w, 0)) * 100)}
      aria-valuemin={0}
      aria-valuemax={100}
      tabIndex={0}
      onPointerDown={(e: ReactPointerEvent<HTMLDivElement>) => {
        if (e.button !== 0) return;
        e.preventDefault();
        press.current = { id: e.pointerId, x: e.clientX, base: weights, live: weights, unlock: lockEdgeDrag('column') };
        e.currentTarget.setPointerCapture(e.pointerId);
      }}
      onPointerMove={(e) => {
        const p = press.current;
        if (!p || p.id !== e.pointerId) return;
        p.live = dragWeights(p.base, at, e.clientX - p.x, width);
        frames.push(p.live);
      }}
      onPointerUp={(e) => finish(e.pointerId, true)}
      onPointerCancel={(e) => finish(e.pointerId, false)}
      onLostPointerCapture={(e) => finish(e.pointerId, true)}
      onKeyDown={(e) => {
        const next = keyWeights(weights, at, e.key, width);
        if (!next) return;
        e.preventDefault();
        if (next !== weights) applySplitOp({ op: 'resize', weights: next });
      }}
    />
  );
}

/**
 * The main area: `children` is the primary pane's page. Without split panes it is that page alone (one column, never
 * outlined); the structure stays the same, so opening a pane never remounts the primary chat.
 */
export function SplitFrame({ children, primaryInert, splits = true }: { children: ReactNode; primaryInert?: boolean; splits?: boolean }) {
  const split = useStore((s) => s.split);
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  // a drag's weights, painted before they are committed on release
  const [live, setLive] = useState<number[] | null>(null);
  useLayoutEffect(() => {
    // the frame's element is always rendered, so it is there by the first layout effect
    const el = ref.current as HTMLDivElement;
    const measure = () => {
      const w = el.getBoundingClientRect().width;
      setWidth(w);
      setSplitRoom(splitRoom(w));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  // a page that shows alone (Settings, the docked panel) keeps the panes for when it is left, and has the focus
  const panes = splits ? split.panes : [];
  const drop = useSplitDrop(ref);
  const hiddenFocus = !splits && split.focus !== 'primary';
  useEffect(() => {
    if (hiddenFocus) applySplitOp({ op: 'focus', target: 'primary' });
  }, [hiddenFocus]);
  // a drag's weights, while they still fit the panes (one closed mid-drag: the layout's own)
  const weights = live?.length === panes.length + 1 ? live : [split.primaryWeight, ...panes.map((p) => p.weight)];
  return (
    <div
      className={panes.length ? 'split-frame split' : 'split-frame'}
      ref={ref}
      style={{ gridTemplateColumns: gridColumns(weights) }}
      onDragOver={splits ? drop.onDragOver : undefined}
      onDragLeave={drop.onDragLeave}
      onDrop={splits ? drop.onDrop : undefined}
    >
      <Pane target="primary" focused={panes.length ? split.focus === 'primary' : null} label="Primary pane" inert={primaryInert}>
        {children}
      </Pane>
      {panes.map((p, i) => [
        <Separator key={`sep-${p.chatId}`} at={i} weights={weights} width={width} onLive={setLive} />,
        <Pane key={p.chatId} target={p.chatId} focused={split.focus === p.chatId} label="Secondary pane">
          <SplitPaneHead chatId={p.chatId} index={i} count={panes.length} />
          <ErrorBoundary label="this chat">
            <ThreadView threadId={p.chatId} />
          </ErrorBoundary>
        </Pane>,
      ])}
      {drop.zone && (
        <div
          className="split-drop"
          aria-hidden="true"
          style={{
            left: drop.zone.box.left,
            top: drop.zone.box.top,
            width: drop.zone.box.right - drop.zone.box.left,
            height: drop.zone.box.bottom - drop.zone.box.top,
          }}
        >
          <span className="split-drop-badge">{drop.zone.label}</span>
        </div>
      )}
    </div>
  );
}
