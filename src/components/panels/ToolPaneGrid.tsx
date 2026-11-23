// A shared grid keeps each tab mounted once while tool tiles resize, gain focus or return to one pane.
import { useLayoutEffect, useRef, type CSSProperties, type ReactNode } from 'react';
import { Columns2, Rows2, Square, X } from '../ui/icons';
import { startEdgeDrag } from '../../lib/edgeDrag';
import { imeComposing } from '../../lib/focus';
import {
  rememberToolLayout,
  removeToolTile,
  resizeToolPair,
  singleToolLayout,
  toolLayout,
  type ToolLayout,
} from '../../lib/toolPaneLayout';
import type { PaneTab } from '../../store/state';

/** Grid coordinates do not change a tab's React parent, so browser pages and terminal shells keep their owners. */
export function toolCell(layout: ToolLayout, index: number, header = false): CSSProperties {
  if (layout.ids.length < 2) return { gridColumn: 1, gridRow: 1 };
  return layout.axis === 'columns'
    ? { gridColumn: index * 2 + 1, gridRow: header ? 1 : 2 }
    : { gridColumn: 1, gridRow: index * 3 + (header ? 1 : 2) };
}
function template(layout: ToolLayout): CSSProperties {
  if (layout.ids.length < 2) return { gridTemplateColumns: 'minmax(0,1fr)', gridTemplateRows: 'minmax(0,1fr)' };
  return layout.axis === 'columns'
    ? { gridTemplateColumns: layout.weights.map((w) => `minmax(0,${w}fr)`).join(' 6px '), gridTemplateRows: 'auto minmax(0,1fr)' }
    : { gridTemplateColumns: 'minmax(0,1fr)', gridTemplateRows: layout.weights.map((w) => `auto minmax(0,${w}fr)`).join(' 6px ') };
}
const label = (tab: PaneTab) =>
  tab.title ||
  (
    { changes: 'Changes', files: 'Files', tasks: 'Tasks', chat: 'Side chat', browser: 'New tab', terminal: 'Terminal' } as Partial<
      Record<PaneTab['kind'], string>
    >
  )[tab.kind] ||
  tab.kind;

export function ToolPaneGrid({
  scope,
  layout,
  tabs,
  select,
  children,
}: {
  scope: string;
  layout: ToolLayout;
  tabs: PaneTab[];
  select(id: string): void;
  children?: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const drag = useRef<(() => void) | null>(null);
  const owner = useRef({ scope, layout });
  const apply = (next: ToolLayout) => Object.assign(ref.current!.style, template(next));
  useLayoutEffect(() => {
    owner.current = { scope, layout };
    Object.assign(ref.current!.style, template(layout));
    return () => {
      drag.current?.();
      drag.current = null;
    };
  }, [scope, layout]);
  const change = (next: ToolLayout) => {
    rememberToolLayout(scope, next);
    select(next.active);
  };
  const split = layout.ids.length > 1;
  return (
    <div className="tool-pane-grid" ref={ref} style={template(layout)} data-axis={layout.axis}>
      {split &&
        layout.ids.map((id, i) => {
          const tab = tabs.find((t) => t.id === id)!;
          return (
            <div key={`head:${id}`} className="tool-tile-head" data-selected={id === layout.active} style={toolCell(layout, i, true)}>
              <button className="tool-tile-label" onClick={() => select(id)} aria-pressed={id === layout.active}>
                {label(tab)}
              </button>
              {i === 0 && (
                <>
                  <button
                    className="icon-btn xs"
                    aria-label="Arrange tools in columns"
                    aria-pressed={layout.axis === 'columns'}
                    onClick={() => change({ ...layout, axis: 'columns' })}
                  >
                    <Columns2 size={14} />
                  </button>
                  <button
                    className="icon-btn xs"
                    aria-label="Arrange tools in rows"
                    aria-pressed={layout.axis === 'rows'}
                    onClick={() => change({ ...layout, axis: 'rows' })}
                  >
                    <Rows2 size={14} />
                  </button>
                  <button className="icon-btn xs" aria-label="Return to one tool pane" onClick={() => change(singleToolLayout(layout))}>
                    <Square size={14} />
                  </button>
                </>
              )}
              <button
                className="icon-btn xs"
                aria-label={`Remove ${label(tab)} from split`}
                onClick={() => change(removeToolTile(layout, id))}
              >
                <X size={14} />
              </button>
            </div>
          );
        })}
      {split &&
        layout.ids.slice(0, -1).map((id, i) => {
          const ratio = layout.weights[i] / (layout.weights[i] + layout.weights[i + 1]);
          const commit = (fraction: number) => change(resizeToolPair(layout, i, fraction));
          return (
            <div
              key={`edge:${id}`}
              role="separator"
              tabIndex={0}
              className="tool-tile-divider"
              aria-label={`Resize tool panes ${i + 1} and ${i + 2}`}
              aria-orientation={layout.axis === 'columns' ? 'vertical' : 'horizontal'}
              aria-valuemin={10}
              aria-valuemax={90}
              aria-valuenow={Math.round(ratio * 100)}
              style={layout.axis === 'columns' ? { gridColumn: i * 2 + 2, gridRow: '1 / 3' } : { gridColumn: 1, gridRow: i * 3 + 3 }}
              onDoubleClick={() => commit(0.5)}
              onKeyDown={(e) => {
                if (imeComposing(e)) return;
                const keys = layout.axis === 'columns' ? ['ArrowLeft', 'ArrowRight'] : ['ArrowUp', 'ArrowDown'];
                const step = keys.indexOf(e.key);
                if (step < 0 && !['Home', 'End', 'Enter'].includes(e.key)) return;
                e.preventDefault();
                let fraction: number;
                if (e.key === 'Home') fraction = 0.1;
                else if (e.key === 'End') fraction = 0.9;
                else if (e.key === 'Enter') fraction = 0.5;
                else fraction = ratio + (step === 0 ? -0.05 : 0.05);
                commit(fraction);
              }}
              // a press leaves the focus where it was
              onMouseDown={(e) => e.preventDefault()}
              onPointerDown={(e) => {
                if (e.button !== 0) return;
                drag.current?.();
                const columns = layout.axis === 'columns';
                const start = columns ? e.clientX : e.clientY;
                const box = ref.current!.getBoundingClientRect();
                const headers = columns
                  ? 0
                  : [...ref.current!.querySelectorAll<HTMLElement>(':scope > .tool-tile-head')].reduce(
                      (sum, header) => sum + header.getBoundingClientRect().height,
                      0,
                    );
                const room = Math.max(1, (columns ? box.width : box.height) - headers - 6 * (layout.ids.length - 1));
                const pair = (room * (layout.weights[i] + layout.weights[i + 1])) / layout.weights.reduce((a, b) => a + b, 0);
                drag.current = startEdgeDrag(e, {
                  axis: columns ? 'column' : 'row',
                  size: (event) => ratio + ((columns ? event.clientX : event.clientY) - start) / pair,
                  apply: (fraction) => apply(resizeToolPair(layout, i, fraction)),
                  ended: () => {
                    drag.current = null;
                  },
                  commit: (fraction) => {
                    if (owner.current.scope === scope && owner.current.layout === layout && toolLayout(scope) === layout) commit(fraction);
                  },
                });
              }}
            />
          );
        })}
      {children}
    </div>
  );
}
