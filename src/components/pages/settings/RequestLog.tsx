// Settings → About → Diagnostics → Request log: the request ledger's last lines (electron/ledger), one per model request,
// filtered by harness, account and outcome, each copyable, with the folder a click away. A failed turn's banner opens it
// on that chat with the turn's lines marked (route.ledger).
import { useRef, useState } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { native } from '../../../lib/native';
import type { LedgerFilter, LedgerLine } from '../../../lib/native/ledger';
import { useEffectOn } from '../../../lib/effects';
import { errorText } from '../../../lib/ignored';
import { copyText } from '../../../session/clipboard';
import { toastFailure, useStore } from '../../../store/core';
import {
  accountText,
  choices,
  costText,
  inFocus,
  modelText,
  OUTCOME_TEXT,
  outcomeText,
  timeText,
  tokensText,
  type LedgerFocus,
} from '../../../lib/requestLog';
import { Group } from './Controls';

const TAB = 'request-log';

export function RequestLogAdvanced() {
  const route = useStore((s) => s.route);
  const tab = route.name === 'settings' ? route.tab : undefined;
  const focus = route.name === 'settings' ? (route.ledger ?? null) : null;
  const [open, setOpen] = useState(tab === TAB);
  useEffectOn([tab, focus?.chat, focus?.from], () => {
    if (tab === TAB) setOpen(true);
  });
  return (
    <>
      <div className="settings-links">
        <button className="link-muted" data-testid="request-log-toggle" onClick={() => setOpen((o) => !o)}>
          Request log {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
        </button>
      </div>
      {open && <RequestLog focus={focus} />}
    </>
  );
}

type Filters = { harness: string; account: string; outcome: string };
const NONE: Filters = { harness: '', account: '', outcome: '' };

export function RequestLog({ focus }: { focus: LedgerFocus | null }) {
  const [filters, setFilters] = useState<Filters>(NONE);
  const [onlyChat, setOnlyChat] = useState(!!focus);
  const [lines, setLines] = useState<LedgerLine[] | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  // every value seen, so a filter's choices don't shrink to the one picked
  const [seen, setSeen] = useState<LedgerLine[]>([]);
  const reads = useRef(0);
  const read = () => {
    // only the newest read lands: an older answer arriving late can't replace it
    const n = ++reads.current;
    const f: LedgerFilter = { limit: 200, ...pick(filters), ...(onlyChat && focus ? { chat: focus.chat } : {}) };
    setFailed(null);
    native.ledger.recent(f).then(
      (r) => {
        if (n !== reads.current) return;
        setLines(r);
        setSeen((s) => [...s, ...r].slice(-1000));
      },
      (e: unknown) => n === reads.current && setFailed(errorText(e)),
    );
  };
  // a link from another turn's banner while the log is open narrows it to that chat again
  useEffectOn([focus?.chat], () => {
    setOnlyChat(!!focus);
  });
  useEffectOn([filters.harness, filters.account, filters.outcome, onlyChat, focus?.chat], () => {
    read();
  });
  const select = (key: keyof Filters, label: string, values: string[], text: (v: string) => string = (v) => v) => (
    <label className="request-log-filter">
      <span>{label}</span>
      <select aria-label={label} value={filters[key]} onChange={(e) => setFilters((f) => ({ ...f, [key]: e.target.value }))}>
        <option value="">All</option>
        {values.map((v) => (
          <option key={v} value={v}>
            {text(v)}
          </option>
        ))}
      </select>
    </label>
  );
  return (
    <Group
      title="Request log"
      desc="One line per model request: harness, account, model, tokens and outcome. Kept 30 days on this computer. Never prompts, replies, tool content or keys."
      action={
        <div className="request-log-actions">
          <button className="btn-pill" onClick={read}>
            Refresh
          </button>
          <button
            className="btn-pill"
            onClick={() =>
              native.ledger
                .reveal()
                .then(
                  (r) => r.ok || toastFailure("Couldn't open the folder")(r.error ?? 'it did not open'),
                  toastFailure("Couldn't open the folder"),
                )
            }
          >
            Reveal folder
          </button>
        </div>
      }
    >
      <div className="request-log" data-testid="request-log">
        <div className="request-log-filters">
          {select(
            'harness',
            'Harness',
            choices(seen, (l) => l.harness),
          )}
          {select(
            'account',
            'Account',
            choices(seen, (l) => l.account?.email ?? l.account?.id),
          )}
          {select('outcome', 'Outcome', Object.keys(OUTCOME_TEXT), (v) => OUTCOME_TEXT[v as LedgerLine['outcome']])}
          {focus && (
            <label className="request-log-filter">
              <input type="checkbox" checked={onlyChat} onChange={(e) => setOnlyChat(e.target.checked)} />
              <span>This chat only</span>
            </label>
          )}
        </div>
        {failed ? (
          <p role="alert">Couldn't read the request log: {failed}</p>
        ) : lines === null ? null : lines.length === 0 ? (
          <p data-testid="request-log-empty">No requests recorded{hasFilter(filters, onlyChat) ? ' that match' : ' yet'}.</p>
        ) : (
          <table className="compat-table request-log-table">
            <thead>
              <tr>
                <th>Time</th>
                <th>Outcome</th>
                <th>Harness</th>
                <th>Account</th>
                <th>Model</th>
                <th>Tokens</th>
                <th title="At the model's list price">Est. cost</th>
                <th aria-label="Copy" />
              </tr>
            </thead>
            <tbody>
              {keyed(lines).map(([key, l]) => (
                <LineRow key={key} l={l} marked={inFocus(l, focus)} />
              ))}
            </tbody>
          </table>
        )}
      </div>
    </Group>
  );
}

function LineRow({ l, marked }: { l: LedgerLine; marked: boolean }) {
  const cls = [marked ? 'marked' : '', l.outcome !== 'ok' ? `outcome-${l.outcome}` : ''].filter(Boolean).join(' ');
  return (
    <>
      <tr className={cls} data-testid="request-log-line">
        <td className="request-log-fixed" title={l.t}>
          {timeText(l.t)}
        </td>
        <td className="request-log-fixed">{outcomeText(l)}</td>
        <td>{l.harness}</td>
        <td>{accountText(l)}</td>
        <td>{modelText(l)}</td>
        <td>{tokensText(l)}</td>
        <td>{costText(l)}</td>
        <td className="request-log-fixed">
          <button className="link-muted" onClick={() => copyText(JSON.stringify(l), 'Line copied')}>
            Copy
          </button>
        </td>
      </tr>
      {l.error && (
        <tr className={`${cls} request-log-error`}>
          <td colSpan={8}>{l.error}</td>
        </tr>
      )}
    </>
  );
}

const pick = (f: Filters): LedgerFilter => ({
  ...(f.harness ? { harness: f.harness } : {}),
  ...(f.account ? { account: f.account } : {}),
  ...(f.outcome ? { outcome: f.outcome } : {}),
});
/** Each line with a key of its own: its content, and how many identical lines came before it. */
function keyed(lines: LedgerLine[]): [string, LedgerLine][] {
  const seen = new Map<string, number>();
  return lines.map((l) => {
    const json = JSON.stringify(l);
    const n = seen.get(json) ?? 0;
    seen.set(json, n + 1);
    return [`${json}#${n}`, l];
  });
}
const hasFilter = (f: Filters, onlyChat: boolean) => onlyChat || !!(f.harness || f.account || f.outcome);
