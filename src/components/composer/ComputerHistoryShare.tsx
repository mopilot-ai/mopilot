// The composer's "Share Computer History" dialog (#1363): pick a range and the apps and sites to include, read the exact text this chat will get, then attach it to the next message; how the harness gets it comes from the chat's computerHistory capability, never its name.
import { useEffect, useMemo, useState } from 'react';
import { native } from '../../lib/native';
import { refusalOf, dayLabel } from '../../store/computerHistory';
import { errorText } from '../../lib/ignored';
import { navigate } from '../../store/panes';
import type { Attachment } from '../../store/types';
import type { CapView } from '../../store/session/capsTypes';
import type { ComputerHistoryMemory } from '../../lib/native/computerHistory';
import { Modal } from '../ui/Modal';

export type HistoryRange = 'today' | 'yesterday' | 'week';
export const RANGES: { id: HistoryRange; label: string }[] = [
  { id: 'today', label: 'Today' },
  { id: 'yesterday', label: 'Yesterday' },
  { id: 'week', label: 'Last 7 days' },
];

/** The local day keys a range covers, newest first. */
export function rangeDays(range: HistoryRange, now = new Date()): string[] {
  const key = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const back = (n: number) => new Date(now.getFullYear(), now.getMonth(), now.getDate() - n);
  if (range === 'today') return [key(back(0))];
  if (range === 'yesterday') return [key(back(1))];
  return Array.from({ length: 7 }, (_, i) => key(back(i)));
}

/** How the chat's harness gets shared memories, in words, from its capability. */
export function deliveryNote(cap: CapView | undefined): string {
  if (cap?.state === 'native') return 'This chat gets them as separate context, kept out of your message.';
  if (cap?.state === 'sage') return "This chat gets them as quoted context ahead of your message, and keeps them in the chat's history.";
  return "This chat can't take shared memories.";
}

/** A source of memories: an app (by bundle id) or a site. */
type Source = { id: string; label: string; site: boolean };
function sourcesOf(memories: ComputerHistoryMemory[]): Source[] {
  const out = new Map<string, Source>();
  for (const m of memories) {
    const id = m.site ? `site:${m.site}` : `app:${m.bundleId}`;
    if (!out.has(id)) out.set(id, { id, label: m.site ?? m.app, site: !!m.site });
  }
  return [...out.values()];
}

/** The attachment for a shared block: short, so the composer's chip shows it whole. */
export function historyAttachment(range: HistoryRange, block: string): Attachment {
  const label = RANGES.find((r) => r.id === range)?.label ?? range;
  return {
    kind: 'computerHistory',
    path: `computer-history:${range}`,
    name: `Computer History · ${label}`,
    text: block,
  };
}

export function ComputerHistoryShare({
  cap,
  onAttach,
  onClose,
}: {
  cap: CapView | undefined;
  onAttach: (a: Attachment) => void;
  onClose: () => void;
}) {
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [range, setRange] = useState<HistoryRange>('today');
  const [all, setAll] = useState<ComputerHistoryMemory[] | null>(null);
  const [off, setOff] = useState<Set<string>>(new Set());
  const [preview, setPreview] = useState<{ text: string; block: string | null } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const usable = cap?.state === 'native' || cap?.state === 'sage';

  useEffect(() => {
    let live = true;
    native.computerHistory.state().then(
      (r) => live && (r.ok ? setEnabled(r.state.settings.enabled) : setError(refusalOf(r))),
      (e) => live && setError(errorText(e)),
    );
    return () => {
      live = false;
    };
  }, []);

  // the range's memories, to list their apps and sites
  const days = useMemo(() => rangeDays(range), [range]);
  useEffect(() => {
    if (!enabled) return;
    let live = true;
    setAll(null);
    setOff(new Set());
    native.computerHistory.memories({ days }).then(
      (r) => live && (r.ok ? setAll(r.memories) : setError(refusalOf(r))),
      (e) => live && setError(errorText(e)),
    );
    return () => {
      live = false;
    };
  }, [enabled, days]);

  // the exact text the chat will get, built by main for what is checked
  const sources = useMemo(() => sourcesOf(all ?? []), [all]);
  useEffect(() => {
    if (!all) return;
    let live = true;
    const apps = sources.filter((s) => !s.site && !off.has(s.id)).map((s) => s.id.slice(4));
    const sites = sources.filter((s) => s.site && !off.has(s.id)).map((s) => s.id.slice(5));
    native.computerHistory.memories({ days, apps, sites }).then(
      (r) => live && (r.ok ? setPreview({ text: r.text, block: r.block }) : setError(refusalOf(r))),
      (e) => live && setError(errorText(e)),
    );
    return () => {
      live = false;
    };
  }, [all, sources, off, days]);

  // what Share does, or nothing while there is nothing this chat can take
  const ready = usable && preview?.block ? { block: preview.block } : null;
  const attach = ready
    ? () => {
        onAttach(historyAttachment(range, ready.block));
        onClose();
      }
    : undefined;
  const toggle = (id: string) =>
    setOff((now) => {
      const next = new Set(now);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const body =
    enabled === false ? (
      <div className="ch-share-off">
        <p>Computer History is off, so there is nothing to share.</p>
        <button
          className="btn-white"
          onClick={() => {
            onClose();
            navigate({ name: 'settings', section: 'computer-history' });
          }}
        >
          Open Computer History settings
        </button>
      </div>
    ) : (
      <>
        <div className="dialog-chips" role="radiogroup" aria-label="Range">
          {RANGES.map((r) => (
            <button
              key={r.id}
              role="radio"
              aria-checked={range === r.id}
              className={`dialog-chip ${range === r.id ? 'on' : ''}`}
              onClick={() => setRange(r.id)}
            >
              {r.label}
            </button>
          ))}
        </div>
        {all && !all.length && (
          <p className="ch-share-empty">No memories {range === 'week' ? 'in the last 7 days' : dayLabel(days[0]).toLowerCase()}.</p>
        )}
        {!!sources.length && (
          <div className="ch-share-sources" aria-label="Include">
            {sources.map((s) => (
              <label key={s.id} className="dialog-check">
                <input type="checkbox" checked={!off.has(s.id)} onChange={() => toggle(s.id)} />
                {s.label}
              </label>
            ))}
          </div>
        )}
        {preview?.block && <pre className="ch-day-text ch-share-preview">{preview.text}</pre>}
        <p className="ch-share-note">{deliveryNote(cap)}</p>
      </>
    );
  return (
    <Modal title="Share Computer History" onClose={onClose}>
      {error && (
        <div className="config-warning" role="alert">
          {error}
        </div>
      )}
      {enabled === null && !error ? <p className="ch-share-empty">Reading…</p> : body}
      <div className="sketch-foot">
        <button className="btn-pill" onClick={onClose}>
          Cancel
        </button>
        <button className="btn-white" disabled={!attach} onClick={attach}>
          Share with this chat
        </button>
      </div>
    </Modal>
  );
}
