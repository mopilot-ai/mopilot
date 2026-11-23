// Canvas layout, typography and data surfaces preserve authored content and ordinary React interactions.
import { createContext, createElement, isValidElement, useContext, useState, type CSSProperties, type ReactNode } from 'react';
import { withKeys } from '../listKeys';
import { useCanvasEnvironment } from './context';
import { toneColor } from './theme';

type Content = { children?: ReactNode; style?: CSSProperties };
const cellKey = (node: ReactNode) =>
  isValidElement<{ children?: ReactNode }>(node) ? String(node.key ?? node.props.children) : String(node);
export const mergeStyle = (base: CSSProperties, override?: CSSProperties) => ({ ...base, ...override });
export function Stack({ children, gap = 12, style }: Content & { gap?: number }) {
  return <div style={{ display: 'flex', flexDirection: 'column', gap, ...style }}>{children}</div>;
}
export function Row({
  children,
  gap = 8,
  align = 'center',
  justify = 'start',
  wrap = false,
  style,
}: Content & { gap?: number; align?: string; justify?: string; wrap?: boolean }) {
  return (
    <div style={{ display: 'flex', gap, alignItems: align, justifyContent: justify, flexWrap: wrap ? 'wrap' : 'nowrap', ...style }}>
      {children}
    </div>
  );
}
export function Grid({
  children,
  columns,
  gap = 16,
  align = 'stretch',
  style,
}: Content & { columns: number | string; gap?: number; align?: string }) {
  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: typeof columns === 'number' ? `repeat(${columns},minmax(0,1fr))` : columns,
        gap,
        alignItems: align,
        ...style,
      }}
    >
      {children}
    </div>
  );
}
export function Divider({ style }: Content) {
  return <hr style={{ width: '100%', border: 0, borderTop: '1px solid var(--border)', margin: '8px 0', ...style }} />;
}
export function Spacer() {
  return <span style={{ flex: 1 }} />;
}
export function H1({ children, style }: Content) {
  return <h1 style={{ margin: 0, fontSize: 'var(--canvas-h1)', ...style }}>{children}</h1>;
}
export function H2({ children, style }: Content) {
  return <h2 style={{ margin: 0, fontSize: 'var(--canvas-h2)', ...style }}>{children}</h2>;
}
export function H3({ children, style }: Content) {
  return <h3 style={{ margin: 0, fontSize: 'var(--canvas-h3)', ...style }}>{children}</h3>;
}
export function Text({
  children,
  tone = 'primary',
  size = 'body',
  as = 'p',
  weight = 'normal',
  italic,
  truncate,
  style,
}: Content & {
  tone?: string;
  size?: string;
  as?: 'p' | 'span';
  weight?: 'normal' | 'medium' | 'semibold' | 'bold';
  italic?: boolean;
  truncate?: boolean | string;
}) {
  return createElement(
    as,
    {
      style: {
        margin: 0,
        color: tone === 'primary' ? 'var(--foreground)' : 'var(--muted-foreground)',
        fontSize: size === 'small' ? 'var(--canvas-small)' : 'var(--canvas-body)',
        fontWeight: { normal: 400, medium: 500, semibold: 600, bold: 700 }[weight],
        fontStyle: italic ? 'italic' : undefined,
        ...(truncate ? { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } : {}),
        ...style,
      },
    },
    children,
  );
}
export function Code({ children, style }: Content) {
  return <code style={{ background: 'var(--muted)', padding: '2px 4px', borderRadius: 3, ...style }}>{children}</code>;
}
export function Link({ children, href, style }: Content & { href: string }) {
  const { publish } = useCanvasEnvironment();
  return (
    <a
      href={href}
      style={{ color: 'var(--blue)', ...style }}
      onClick={(event) => {
        event.preventDefault();
        publish({ type: 'link', href });
      }}
    >
      {children}
    </a>
  );
}
export function Table({
  headers,
  rows,
  columnAlign = [],
  rowTone = [],
  framed = true,
  striped,
  stickyHeader,
  emptyMessage = 'No rows',
  style,
}: {
  headers: ReactNode[];
  rows: ReactNode[][];
  columnAlign?: ('left' | 'center' | 'right' | undefined)[];
  rowTone?: (string | undefined)[];
  framed?: boolean;
  striped?: boolean;
  stickyHeader?: boolean;
  emptyMessage?: ReactNode;
  style?: CSSProperties;
}) {
  const columns = withKeys(headers, cellKey);
  return (
    <div style={{ overflow: 'auto', border: framed ? '1px solid var(--border)' : undefined, borderRadius: 6, ...style }}>
      <table style={{ borderCollapse: 'collapse', width: '100%' }}>
        <thead style={stickyHeader ? { position: 'sticky', top: 0, background: 'var(--background)' } : undefined}>
          <tr>
            {columns.map(({ key, item: header, index }) => (
              <th key={key} style={{ textAlign: columnAlign[index] ?? 'left', padding: 10, borderBottom: '1px solid var(--border)' }}>
                {header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.length ? (
            withKeys(rows, (row) => cellKey(row[0])).map(({ key, item: row, index: rowIndex }) => (
              <tr key={key} style={{ background: striped && rowIndex % 2 === 1 ? 'var(--muted)' : undefined }}>
                {columns.map(({ key, index }) => (
                  <td
                    key={key}
                    style={{
                      textAlign: columnAlign[index] ?? 'left',
                      verticalAlign: 'top',
                      padding: 10,
                      borderBottom: '1px solid var(--border)',
                    }}
                  >
                    {index === 0 && rowTone[rowIndex] && (
                      <span aria-label={rowTone[rowIndex]} style={{ color: `var(--${toneColor(rowTone[rowIndex])})`, marginRight: 6 }}>
                        ●
                      </span>
                    )}
                    {row[index]}
                  </td>
                ))}
              </tr>
            ))
          ) : (
            <tr>
              <td colSpan={headers.length}>{emptyMessage}</td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}
const CardContext = createContext<{ open: boolean; collapsible: boolean; toggle?: () => void }>({ open: true, collapsible: false });
export function Card({
  children,
  variant = 'default',
  size,
  stickyHeader,
  collapsible = false,
  defaultOpen = true,
  open,
  onOpenChange,
  style,
}: Content & {
  variant?: string;
  size?: string;
  stickyHeader?: boolean;
  collapsible?: boolean;
  defaultOpen?: boolean;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}) {
  const [local, setLocal] = useState(defaultOpen);
  const expanded = open ?? local;
  const toggle = () => {
    setLocal(!expanded);
    onOpenChange?.(!expanded);
  };
  return (
    <CardContext.Provider value={{ open: expanded, collapsible, toggle }}>
      <section
        style={{
          border: variant === 'borderless' ? undefined : '1px solid var(--border)',
          borderRadius: 8,
          fontSize: size === 'lg' ? 'var(--canvas-h3)' : undefined,
          ...style,
        }}
        data-sticky-header={stickyHeader || undefined}
      >
        {children}
      </section>
    </CardContext.Provider>
  );
}
export function CardHeader({ children, trailing, style }: Content & { trailing?: ReactNode }) {
  const card = useContext(CardContext);
  return (
    <div className="canvas-card-header" style={style}>
      {card.collapsible ? (
        <button type="button" className="canvas-disclosure" aria-expanded={card.open} onClick={card.toggle}>
          {children}
        </button>
      ) : (
        children
      )}
      <span style={{ marginLeft: 'auto' }}>{trailing}</span>
    </div>
  );
}
export function CardBody({ children, style }: Content) {
  const card = useContext(CardContext);
  return card.collapsible && !card.open ? null : <div style={{ padding: 16, ...style }}>{children}</div>;
}
export function CollapsibleSection({
  title,
  leading,
  count,
  trailing,
  children,
  defaultOpen = false,
  style,
}: Content & { title: string; leading?: ReactNode; count?: number; trailing?: ReactNode; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <section style={style}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <button type="button" className="canvas-disclosure" aria-expanded={open} onClick={() => setOpen(!open)}>
          {open ? '▾' : '▸'} {leading}
          {title}
          {count !== undefined && <span> ({count})</span>}
        </button>
        {trailing}
      </div>
      {open && <div style={{ padding: '12px 0 12px 16px' }}>{children}</div>}
    </section>
  );
}
export function Stat({ value, label, tone, style }: { value: ReactNode; label: string; tone?: string; style?: CSSProperties }) {
  return (
    <div style={style}>
      <div style={{ fontSize: 'var(--canvas-h1)', fontWeight: 600, color: `var(--${toneColor(tone)})` }}>{value}</div>
      <div style={{ color: 'var(--muted-foreground)', fontSize: 'var(--canvas-small)' }}>{label}</div>
    </div>
  );
}
export function Callout({ children, tone, title, icon, style }: Content & { tone?: string; title?: ReactNode; icon?: ReactNode }) {
  return (
    <aside style={{ padding: 14, background: 'var(--muted)', borderRadius: 6, ...style }}>
      <div style={{ fontWeight: 600, color: `var(--${toneColor(tone)})` }}>
        {icon}
        {title}
      </div>
      {children}
    </aside>
  );
}
