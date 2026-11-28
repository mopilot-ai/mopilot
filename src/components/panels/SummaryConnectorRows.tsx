// The session rail's connector rows, as Claude Desktop's: every server, used and failing first, three before "Show more",
// and a click that signs in or reconnects one that needs it on the chat's own harness, or opens its management page.
import { useEffect, useRef, useState } from 'react';
import type { HarnessFamily } from '../../harness/family';
import { useStore, toastFailure } from '../../store/core';
import { reconnectConnector, signInConnector, watchSignIns, type HeldReconnects } from '../../session/harness/connectorActions';
import { CONNECTORS_SHOWN, orderConnectors, usedServers } from '../../session/harness/connectorOrder';
import type { Connector } from '../../session/harness/mcpRows';
import { Plug } from '../ui/icons';

/**
 * A row's progress since its click. `browser`: the harness finishes the sign-in itself, so another click starts over.
 * `finish`: the page can't call back (a claude.ai connector), so the next click reconnects.
 */
type Phase = 'opening' | 'browser' | 'finish' | 'reconnecting';
/** A phase holds for the row's action it was started for: one that changed state or action starts fresh. */
type Started = { phase: Phase; action: Connector['action'] };

/** What the row says at its end, and whether it asks for the user's click. */
function trailing(row: Connector, phase: Phase | undefined, held: HeldReconnects): { text: string; warn?: boolean; hint?: string } | null {
  if (row.state === 'attention') {
    if (phase === 'opening') return { text: 'Opening sign-in…' };
    if (phase === 'reconnecting' || held.reconnecting.includes(row.name)) return { text: 'Reconnecting…' };
    if (held.waiting.includes(row.name)) return { text: 'Reconnects when this turn finishes' };
    if (phase === 'browser')
      return { text: 'Finish in browser', warn: true, hint: 'Finish signing in in your browser. Click to start again.' };
    if (phase === 'finish') return { text: 'Reconnect', warn: true, hint: 'Finish signing in in your browser, then click to reconnect.' };
    return { text: row.action === 'connect' ? 'Connect' : 'Reconnect', warn: true, hint: row.status };
  }
  if (row.state === 'off') return { text: 'Off', hint: row.status };
  if (row.state === 'unavailable') return { text: 'Unavailable', hint: row.status };
  if (row.state === 'pending' || (row.state === 'configured' && row.status !== 'Configured')) return { text: row.status };
  return null;
}

export function SummaryConnectorRows({
  chatId,
  family,
  nativeId,
  rows,
  held,
  manage,
  refresh,
}: {
  chatId: string;
  family: HarnessFamily;
  nativeId: string;
  rows: Connector[];
  held: HeldReconnects;
  manage: () => void;
  refresh: () => void;
}) {
  const turns = useStore((s) => s.runtime[chatId]?.turns);
  const [started, setStarted] = useState<Record<string, Started>>({});
  const [all, setAll] = useState(false);
  // the order holds while the pointer or focus is in the list, so a row doesn't move under the click
  const [inside, setInside] = useState({ pointer: false, focus: false });
  const [frozen, setFrozen] = useState<string[] | null>(null);
  const fresh = orderConnectors(rows, usedServers(turns ?? []));
  const names = fresh.map((row) => row.name);
  const byName = new Map(fresh.map((row) => [row.name, row]));
  const order = frozen ? [...frozen.filter((name) => byName.has(name)), ...names.filter((name) => !frozen.includes(name))] : names;
  const ordered = order.map((name) => byName.get(name)!);
  const shown = all ? ordered : ordered.slice(0, CONNECTORS_SHOWN);
  const enter = (where: 'pointer' | 'focus', now: boolean) => {
    const next = { ...inside, [where]: now };
    setInside(next);
    if (!next.pointer && !next.focus) setFrozen(null);
    else setFrozen((was) => was ?? names);
  };
  const phaseOf = (row: Connector) => {
    const s = started[row.name];
    return row.state === 'attention' && s?.action === row.action ? s.phase : undefined;
  };
  const set = (row: Connector, phase: Phase | undefined) =>
    setStarted(({ [row.name]: _, ...rest }) => (phase ? { ...rest, [row.name]: { phase, action: row.action } } : rest));

  // a row that connected (or changed what it needs) forgets its last click, so the next time it needs sign-in it offers
  // Connect again; a row missing only while the list is re-read keeps it
  useEffect(() => {
    setStarted((was) => {
      const gone = rows.filter((row) => was[row.name] && (row.state !== 'attention' || was[row.name].action !== row.action));
      if (!gone.length) return was;
      const keep = { ...was };
      for (const row of gone) delete keep[row.name];
      return keep;
    });
  }, [rows]);

  // a Codex sign-in reports its end: a failure is said, and either way the row starts fresh
  const startedNow = useRef(started);
  useEffect(() => {
    startedNow.current = started;
  });
  const signingIn = Object.values(started).some((s) => s.phase === 'browser');
  useEffect(() => {
    if (!signingIn) return;
    return watchSignIns(family, nativeId, (name, error) => {
      if (!startedNow.current[name]) return;
      if (error !== null) toastFailure(`Couldn't sign in to ${name}`)(error);
      setStarted(({ [name]: _, ...rest }) => rest);
    });
  }, [family, nativeId, signingIn]);

  const reconnect = (row: Connector) => {
    set(row, 'reconnecting');
    reconnectConnector(family, nativeId, row.name)
      .then(
        () => set(row, undefined),
        (error) => {
          set(row, undefined);
          toastFailure(`Couldn't reconnect ${row.name}`)(error);
        },
      )
      .finally(refresh);
  };
  const signIn = (row: Connector) => {
    set(row, 'opening');
    signInConnector(family, nativeId, row.name).then(
      (step) => {
        set(row, step === 'none' ? undefined : step);
        if (step === 'none') refresh();
      },
      (error) => {
        set(row, undefined);
        toastFailure(`Couldn't sign in to ${row.name}`)(error);
      },
    );
  };
  const press = (row: Connector) => {
    if (row.state !== 'attention' || !row.action) return manage();
    const now = phaseOf(row);
    if (now === 'opening' || now === 'reconnecting' || held.waiting.includes(row.name) || held.reconnecting.includes(row.name)) return;
    if (row.action === 'reconnect' || now === 'finish') return reconnect(row);
    signIn(row);
  };

  return (
    <div
      className="summary-connector-list"
      role="group"
      aria-label="Connectors"
      onPointerEnter={() => enter('pointer', true)}
      onPointerLeave={() => enter('pointer', false)}
      onFocus={() => !inside.focus && enter('focus', true)}
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) enter('focus', false);
      }}
    >
      {shown.map((row) => {
        const end = trailing(row, phaseOf(row), held);
        return (
          <button
            key={row.name}
            type="button"
            className="summary-row summary-connector"
            title={end?.hint ?? row.status}
            aria-label={`${row.name}, ${end?.text ?? row.status}`}
            onClick={() => press(row)}
          >
            <Plug size={14} aria-hidden="true" />
            <span className="summary-label">{row.name}</span>
            {end && <span className={end.warn ? 'summary-hint warn' : 'summary-hint'}>{end.text}</span>}
          </button>
        );
      })}
      {ordered.length > CONNECTORS_SHOWN && (
        <button type="button" className="summary-row summary-connector-more" aria-expanded={all} onClick={() => setAll(!all)}>
          <span className="summary-label">{all ? 'Show less' : 'Show more'}</span>
        </button>
      )}
    </div>
  );
}
