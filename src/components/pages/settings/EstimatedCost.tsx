// Settings → Accounts & billing → Estimated cost: what this computer's chats would cost at API list prices, from the request
// ledger (src/lib/costView.ts over window.native.ledger.summary): the range's total, a bar per day, and the costliest harnesses
// and models. Chats on a subscription plan are included at that price, and said to be; requests with no list price are counted apart.
import { useRef, useState } from 'react';
import { native } from '../../../lib/native';
import type { LedgerImportResult, LedgerSummary } from '../../../lib/native/ledger';
import { useEffectOn } from '../../../lib/effects';
import { userError } from '../../../../shared/userError.mjs';
import { useStore } from '../../../store/core';
import { formatTokens, pluralize } from '../../../lib/format';
import { COST_RANGES, dayBars, overviewOf, rangeDays, totalsBy, usdText, type CostRange, type CostTotal } from '../../../lib/costView';
import { harnessInfo } from '../../../harness/registry';
import { Group } from './Controls';

/** How many harnesses and models a table names. */
const TOP = 8;

/** A harness's name as the app shows it; an ACP agent the ledger names by its id is looked up as `acp:<id>`. */
export function harnessLabel(id: string): string {
  return harnessInfo(id as never)?.label ?? harnessInfo(`acp:${id}` as never)?.label ?? id;
}

/** What an import of outside sessions' usage found, in words. */
export function importText(r: LedgerImportResult): string {
  if ('refused' in r)
    return r.refused === 'off'
      ? 'The request log is off (Settings → Privacy), so nothing was imported.'
      : 'The request log has not started yet.';
  const claude = `${pluralize(r.claude.read, 'new or changed Claude Code transcript')} of ${r.claude.files}`;
  const codex = `${pluralize(r.codex.read, 'new or changed Codex session file')} of ${r.codex.files}`;
  const failed = r.claude.failed + r.codex.failed;
  const unread = failed ? ` ${pluralize(failed, 'file')} couldn't be read; any earlier import of them is kept.` : '';
  return `Read ${claude} and ${codex}.${unread} Sessions run outside MoPilot are included as of now: press again to add later ones.`;
}

/** A summary with the range and the moment it was read for: what is drawn is always the answer to the range it names. */
type Shown = { range: CostRange; at: number; summary: LedgerSummary };

export function EstimatedCost({ now = Date.now }: { now?: () => number }) {
  const recording = useStore((s) => s.prefs.requestLog) !== false;
  const [range, setRange] = useState<CostRange>('30');
  const [shown, setShown] = useState<Shown | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const reads = useRef(0);
  const read = () => {
    // only the newest read lands: an older range's answer arriving late can't replace it
    const n = ++reads.current;
    const at = now();
    const asked = range;
    setFailed(null);
    native.ledger.summary(rangeDays(asked, at)).then(
      (summary) => n === reads.current && setShown({ range: asked, at, summary }),
      (e: unknown) => n === reads.current && setFailed(userError(e)),
    );
  };
  useEffectOn([range], () => {
    read();
  });
  const [importing, setImporting] = useState(false);
  const [imported, setImported] = useState<string | null>(null);
  const importOutside = () => {
    setImporting(true);
    setImported(null);
    native.ledger.importOutside().then(
      (r) => {
        setImporting(false);
        setImported(importText(r));
        read();
      },
      (e: unknown) => {
        setImporting(false);
        setImported(`Couldn't read Claude Code's and Codex's own sessions: ${userError(e)}`);
      },
    );
  };
  // a range picked while its answer is on the way shows no other range's numbers under its name
  const current = shown?.range === range ? shown : null;
  const o = current && overviewOf(current.summary);
  return (
    <Group
      title="Estimated cost"
      desc="What the requests recorded on this computer would cost at each model's list price. Chats on a plan are included at that price: they are not billed per request."
      action={
        <div className="request-log-actions">
          <select aria-label="Range" value={range} onChange={(e) => setRange(e.target.value as CostRange)}>
            {COST_RANGES.map((r) => (
              <option key={r.value} value={r.value}>
                {r.label}
              </option>
            ))}
          </select>
          <button className="btn-pill" onClick={read}>
            Refresh
          </button>
          <button className="btn-pill" onClick={importOutside} disabled={importing || !recording}>
            {importing ? 'Reading Claude Code and Codex sessions…' : 'Include sessions run outside MoPilot'}
          </button>
        </div>
      }
    >
      <div className="estimated-cost" data-testid="estimated-cost">
        {!recording && <p className="estimated-cost-note">The request log is off (Settings → Privacy), so new requests are not counted.</p>}
        {imported && (
          <p className="estimated-cost-note" role="status" data-testid="estimated-cost-imported">
            {imported}
          </p>
        )}
        {failed ? (
          <p role="alert">Couldn't read the request log: {failed}</p>
        ) : !current || !o ? (
          <p className="estimated-cost-note">Reading the request log…</p>
        ) : o.requests === 0 ? (
          <p data-testid="estimated-cost-empty">No requests recorded in this range yet.</p>
        ) : (
          <>
            <p className="estimated-cost-total" data-testid="estimated-cost-total">
              About <strong>{usdText(o.usd)}</strong> for {pluralize(o.requests - o.unpriced, 'priced request')}
              {o.planUsd > 0 && <>, {usdText(o.planUsd)} of it in chats on a plan</>}.
            </p>
            {o.unpriced > 0 && (
              <p className="estimated-cost-note">Left out: {pluralize(o.unpriced, 'request')} to a model with no known list price.</p>
            )}
            {o.incomplete && (
              <p className="estimated-cost-note" role="status">
                Part of the older history could not be read, so this total may be low.
              </p>
            )}
            <DayBars bars={dayBars(current.summary.rows, current.range, current.at)} />
            <Totals title="By harness" totals={totalsBy(current.summary.rows, 'harness', harnessLabel)} />
            <Totals title="By model" totals={totalsBy(current.summary.rows, 'model')} />
          </>
        )}
      </div>
    </Group>
  );
}

function DayBars({ bars }: { bars: ReturnType<typeof dayBars> }) {
  if (!bars.length) return null;
  return (
    <div className="estimated-cost-days" role="list" aria-label="Cost per day">
      {bars.map((b) => (
        <div
          key={b.day}
          className="estimated-cost-day"
          role="listitem"
          aria-label={`${b.day}: ${usdText(b.usd)}`}
          title={`${b.day}: ${usdText(b.usd)}`}
        >
          <div className="estimated-cost-day-fill" style={{ height: `${Math.round(b.share * 100)}%` }} />
        </div>
      ))}
    </div>
  );
}

function Totals({ title, totals }: { title: string; totals: CostTotal[] }) {
  const shown = totals.slice(0, TOP);
  const rest = totals.length - shown.length;
  return (
    <table className="compat-table estimated-cost-table">
      <caption>{title}</caption>
      <thead>
        <tr>
          <th>{title === 'By harness' ? 'Harness' : 'Model'}</th>
          <th>Requests</th>
          <th>Tokens</th>
          <th>Estimated cost</th>
        </tr>
      </thead>
      <tbody>
        {shown.map((t) => (
          <tr key={t.key} data-testid="estimated-cost-row">
            <td>{t.label}</td>
            <td>{t.requests.toLocaleString()}</td>
            <td>{formatTokens(t.tokens)}</td>
            <td>
              {t.unpriced === t.requests
                ? 'No list price'
                : t.unpriced
                  ? `${usdText(t.usd)} + ${t.unpriced.toLocaleString()} unpriced`
                  : usdText(t.usd)}
            </td>
          </tr>
        ))}
        {rest > 0 && (
          <tr>
            <td colSpan={4}>and {rest} more</td>
          </tr>
        )}
      </tbody>
    </table>
  );
}
