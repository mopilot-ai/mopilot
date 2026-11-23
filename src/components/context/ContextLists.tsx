// The context dialog's rows: each group in the window, collapsible into the names it was reported as and what each holds (MCP tools, memory files, skills and agents, a full read's system prompt, tools and messages), and the tokens measured for the last request and the session.
import type { ContextDetails, ContextLists as Lists, NamedTokens, TokenBreakdown } from '../../../shared/contextSnapshot.mjs';
import { contextTokens } from '../../lib/contextFormat';
import { openFile } from '../../session/open';
import { basename } from '../../lib/paths';
import { ChevronRight } from '../ui/icons';
import { shareOf, type ContextMeterModel, type LegendRow } from './contextMeter';

interface Item {
  key: string;
  name: string;
  tokens: number;
  title?: string;
  onOpen?: () => void;
}

const itemsOf = (rows: NamedTokens[], prefix: string): Item[] =>
  rows.map((x, i) => ({ key: `${prefix}${i}`, name: x.name, tokens: x.tokens }));

/** What a reported name holds, from the lists a breakdown gives (and a full read adds). */
function itemsFor(name: string, lists: Lists | null, details: ContextDetails | null): Item[] {
  const mcp = (deferred: boolean) =>
    (lists?.mcpTools ?? [])
      .filter((t) => !!t.deferred === deferred)
      .map((t, i) => ({ key: `m${i}`, name: t.server ? `${t.server} · ${t.name}` : t.name, tokens: t.tokens }));
  switch (name) {
    case 'System prompt':
      return itemsOf(details?.systemPrompt ?? [], 'p');
    case 'System tools':
      return itemsOf(details?.systemTools ?? [], 't');
    case 'MCP tools':
      return mcp(false);
    case 'MCP tools (deferred)':
      return mcp(true);
    case 'Memory files':
      return (lists?.memoryFiles ?? []).map((f, i) => ({
        key: `f${i}`,
        name: basename(f.path),
        title: f.path,
        tokens: f.tokens,
        onOpen: () => openFile(f.path),
      }));
    case 'Skills':
      return itemsOf(lists?.skills ?? [], 's');
    case 'Custom agents':
      return itemsOf(lists?.agents ?? [], 'a');
    case 'Messages':
      return [
        ...itemsOf(details?.messages ?? [], 'g'),
        ...(details?.toolCalls ?? []).map((t, i) => ({
          key: `c${i}`,
          name: `${t.name} calls`,
          tokens: t.callTokens + t.resultTokens,
          title: `${contextTokens(t.callTokens)} in calls, ${contextTokens(t.resultTokens)} in results`,
        })),
      ];
    default:
      return [];
  }
}

function ItemRow({ item }: { item: Item }) {
  return (
    <div className="ctx-item" title={item.title}>
      {item.onOpen ? (
        <button type="button" className="ctx-link" onClick={item.onOpen}>
          {item.name}
        </button>
      ) : (
        <span className="ctx-item-name">{item.name}</span>
      )}
      <span className="ctx-num">{contextTokens(item.tokens)}</span>
    </div>
  );
}

/** A reported name under its group: a row, or a collapsible one when its items are known. */
function Part({ part, lists, details }: { part: NamedTokens; lists: Lists | null; details: ContextDetails | null }) {
  const items = itemsFor(part.name, lists, details);
  if (!items.length) return <ItemRow item={{ key: part.name, name: part.name, tokens: part.tokens }} />;
  return (
    <details className="ctx-part">
      <summary className="ctx-item">
        <span className="ctx-item-name">
          {part.name} <span className="ctx-count">{items.length}</span>
        </span>
        <span className="ctx-num">{contextTokens(part.tokens)}</span>
      </summary>
      <div className="ctx-items">
        {items.map((it) => (
          <ItemRow key={it.key} item={it} />
        ))}
      </div>
    </details>
  );
}

/** What a group's row says under it when it has no reported names: why the reserve and deferred tools are there. */
const ASIDE: Partial<Record<LegendRow['series'], string>> = {
  buffer: 'Held back so a summary always fits',
  deferred: 'Loaded only when used, not counted above',
};

/** One group: its swatch, name, tokens and share, opening into the names it was reported as. */
function Category({
  row,
  model,
  lists,
  details,
}: {
  row: LegendRow;
  model: ContextMeterModel;
  lists: Lists | null;
  details: ContextDetails | null;
}) {
  const aside = ASIDE[row.series];
  const head = (
    <>
      <ChevronRight size={12} className="ctx-chev" aria-hidden="true" />
      <i className="ctx-swatch" data-series={row.series} aria-hidden="true" />
      <span className="ctx-legend-label">
        {row.label}
        {row.estimated && <span className="ctx-est">est.</span>}
      </span>
      <span className="ctx-num">{contextTokens(row.tokens)}</span>
      <span className="ctx-share">{shareOf(row, model.window)}</span>
    </>
  );
  if (!row.parts.length && !aside)
    return (
      <div className="ctx-cat" data-series={row.series}>
        {head}
      </div>
    );
  return (
    <details className="ctx-group" data-series={row.series}>
      <summary className="ctx-cat">{head}</summary>
      <div className="ctx-items">
        {row.parts.map((p) => (
          <Part key={p.name} part={p} lists={lists} details={details} />
        ))}
        {aside && <p className="ctx-aside">{aside}</p>}
      </div>
    </details>
  );
}

/** Every group in the window and outside it, in the bar's palette order. */
export function CategoryRows({ model, lists, details }: { model: ContextMeterModel; lists: Lists | null; details: ContextDetails | null }) {
  return (
    <div className="ctx-cats">
      {model.legend.map((r) => (
        <Category key={r.id} row={r} model={model} lists={lists} details={details} />
      ))}
    </div>
  );
}

/** "$0.42", or "0.42 XYZ" for a currency code Intl does not know (the agent's own words). */
export function money(cost: { amount: number; currency: string }): string {
  try {
    return new Intl.NumberFormat(undefined, { style: 'currency', currency: cost.currency }).format(cost.amount);
  } catch {
    return `${cost.amount} ${cost.currency}`;
  }
}

const TOKEN_ROWS: [keyof TokenBreakdown, string][] = [
  ['inputTokens', 'Input'],
  ['cachedInputTokens', 'Read from cache'],
  ['cacheWriteInputTokens', 'Written to cache'],
  ['outputTokens', 'Output'],
  ['reasoningOutputTokens', 'Reasoning'],
  ['totalTokens', 'Total'],
];

/** The tokens measured: the last request and the session so far, each column only when the harness reported it. */
export function TokenTable({
  lastRequest,
  session,
  cost,
}: {
  lastRequest: TokenBreakdown | null;
  session: TokenBreakdown | null;
  cost: { amount: number; currency: string } | null;
}) {
  if (!lastRequest && !session && !cost) return null;
  const rows = TOKEN_ROWS.filter(([k]) => (lastRequest?.[k] ?? 0) > 0 || (session?.[k] ?? 0) > 0);
  return (
    <table className="ctx-tokens">
      {rows.length > 0 && (
        <>
          <thead>
            <tr>
              <th>Tokens</th>
              {lastRequest && <th>Last request</th>}
              {session && <th>This session</th>}
            </tr>
          </thead>
          <tbody>
            {rows.map(([k, label]) => (
              <tr key={k} data-total={k === 'totalTokens' || undefined}>
                <td>{label}</td>
                {lastRequest && <td className="ctx-num">{contextTokens(lastRequest[k])}</td>}
                {session && <td className="ctx-num">{contextTokens(session[k])}</td>}
              </tr>
            ))}
          </tbody>
        </>
      )}
      {cost && (
        <tfoot>
          <tr>
            <td>Cost</td>
            <td className="ctx-num" colSpan={2}>
              {money(cost)}
            </td>
          </tr>
        </tfoot>
      )}
    </table>
  );
}
