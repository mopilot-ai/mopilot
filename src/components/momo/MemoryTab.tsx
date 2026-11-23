// MoMo's Memory tab (#2139): About you and MoMo's persona to edit, and the facts, searchable, each with where it came from (you, or the harness of the MoMo chat that saved it; Inferred when MoMo wrote it on its own after a chat; sure or likely, date, expired) and Edit / Delete, and a fact to add; the recent changes with Undo and the past facts a newer one replaced (MemoryChanges.tsx); the open loops (OpenLoops.tsx); everything read again whenever the memory changes (MoMo saving or forgetting included). Main refuses every call while MoMo is not allowed (the tab then shows nothing) or can't encrypt the memory (one "Memory is off" line) (electron/momo/memoryIpc.cjs).
import { useCallback, useEffect, useState } from 'react';
import { native } from '../../lib/native';
import { errorText } from '../../lib/ignored';
import type { MomoFact, MomoMemoryFile, MomoMemoryResult } from '../../lib/native/contracts/momoMemory';
import { Group, Row } from '../pages/settings/Controls';
import { busyField, isEnter } from '../../lib/focus';
import { day, sourceName, useRead } from './memoryRead';
import { PastFacts, RecentChanges } from './MemoryChanges';
import { OpenLoops } from './OpenLoops';
import { WrittenChanges } from './WrittenChanges';

export { harnessName } from './memoryRead';

/**
 * One document (About you, the persona): edited in place, saved on Save. Until the user edits it, it shows what is
 * saved now; an edit whose text changed elsewhere meanwhile says so (Save replaces it). A failed save keeps the draft.
 */
function DocEditor({ name, label, text, unreadable }: { name: MomoMemoryFile; label: string; text: string; unreadable: boolean }) {
  const [base, setBase] = useState(text);
  const [draft, setDraft] = useState(text);
  /** what was just saved, until main's re-read shows it */
  const [pending, setPending] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (pending !== null) {
      if (text === pending) setPending(null);
      return;
    }
    // not edited: follow what is saved
    if (draft === base && text !== base) {
      setDraft(text);
      setBase(text);
    }
  }, [text, draft, base, pending]);
  const stale = pending === null && draft !== base && text !== base;
  const save = async () => {
    setBusy(true);
    const wrote = draft;
    try {
      const r = await native.momoMemory.writeFile(name, wrote);
      if (r.ok) {
        setBase(wrote);
        if (text !== wrote) setPending(wrote);
        setError(null);
      } else setError(r.error);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  const note = error
    ? `Couldn't save: ${error}`
    : stale
      ? 'Changed elsewhere. Saving replaces it.'
      : unreadable && pending === null && draft === base
        ? "Couldn't decrypt this. Saving replaces it."
        : null;
  return (
    <>
      <textarea
        className="text-area settings-textarea momo-doc"
        aria-label={label}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
      />
      <div className="momo-doc-foot">
        {note && (
          <span className="config-warning" role={error ? 'alert' : undefined}>
            {note}
          </span>
        )}
        <button className="btn-pill" disabled={busy || (draft === base && !stale)} aria-busy={busy} onClick={() => void save()}>
          {busy ? 'Saving…' : 'Save'}
        </button>
      </div>
    </>
  );
}

/** One fact's row: its text and source chips, Edit (in place) and Delete (asks in place first). */
function FactRow({ fact, now, changed }: { fact: MomoFact; now: number; changed: () => void }) {
  const [editing, setEditing] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [draft, setDraft] = useState(fact.text);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = async (call: () => Promise<MomoMemoryResult>) => {
    setBusy(true);
    let r: MomoMemoryResult;
    try {
      r = await call();
    } catch (e) {
      r = { ok: false, error: errorText(e) };
    }
    setBusy(false);
    setError(r.ok ? null : r.error);
    if (r.ok) changed();
    return r.ok;
  };
  const expired = fact.expiresAt !== undefined && fact.expiresAt <= now;
  // correcting an expired fact brings it back: the user just said it holds
  const save = async () => {
    if (await run(() => native.momoMemory.update(fact.id, { text: draft, ...(expired ? { expiresAt: null } : {}) }))) setEditing(false);
  };
  const remove = async () => {
    await run(() => native.momoMemory.forget(fact.id));
    setConfirming(false);
  };
  const chips = (
    <span className="momo-chips">
      <span className="applies-to momo-chip">{sourceName(fact.source)}</span>
      {fact.origin === 'extracted' && (
        <span className="applies-to momo-chip" title="MoMo wrote this on its own after a chat">
          Inferred
        </span>
      )}
      <span className="applies-to momo-chip">{fact.confidence === 'sure' ? 'Sure' : 'Likely'}</span>
      <span className="applies-to momo-chip">{day(fact.createdAt)}</span>
      {expired && <span className="applies-to momo-chip expired">Expired</span>}
    </span>
  );
  return (
    <div className="momo-fact" data-fact={fact.id}>
      {editing ? (
        <div className="momo-fact-edit">
          <textarea
            className="text-area settings-textarea"
            aria-label="Fact"
            value={draft}
            autoFocus
            onChange={(e) => setDraft(e.target.value)}
          />
          <div className="momo-doc-foot">
            <button
              className="btn-pill soft"
              onClick={() => {
                setEditing(false);
                setDraft(fact.text);
                setError(null);
              }}
            >
              Cancel
            </button>
            <button
              className="btn-pill"
              disabled={busy || !draft.trim() || draft === fact.text}
              aria-busy={busy}
              onClick={() => void save()}
            >
              {busy ? 'Saving…' : 'Save'}
            </button>
          </div>
        </div>
      ) : (
        <Row title={fact.text} desc={chips}>
          {confirming ? (
            <>
              <button className="btn-pill soft" onClick={() => setConfirming(false)}>
                Cancel
              </button>
              <button
                className="btn-pill danger"
                disabled={busy}
                aria-label={`Confirm deleting "${fact.text}"`}
                onClick={() => void remove()}
              >
                Delete
              </button>
            </>
          ) : (
            <>
              <button className="btn-pill soft" onClick={() => setEditing(true)}>
                Edit
              </button>
              <button className="btn-pill soft" aria-label={`Delete "${fact.text}"`} onClick={() => setConfirming(true)}>
                Delete
              </button>
            </>
          )}
        </Row>
      )}
      {error && (
        <div className="config-warning" role="alert">
          {error}
        </div>
      )}
    </div>
  );
}

/** A fact the user types: saved as theirs (sure) on Add or Enter; a failed add keeps the text and says why. */
function AddFact({ added, disabled }: { added: () => unknown; disabled: boolean }) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const can = !disabled && !busy && !!text.trim();
  const add = async () => {
    setBusy(true);
    try {
      const r = await native.momoMemory.add(text);
      if (r.ok) {
        setText('');
        setError(null);
        added();
      } else setError(r.error);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="momo-add">
      <input
        className="text-input slim wide"
        aria-label="Add a fact"
        placeholder="Add something MoMo should remember"
        value={text}
        {...busyField(disabled)}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (isEnter(e) && can) void add();
        }}
      />
      <button className="btn-pill" disabled={!can} aria-busy={busy} onClick={() => void add()}>
        Add
      </button>
      {error && (
        <span className="config-warning" role="alert">
          {error}
        </span>
      )}
    </div>
  );
}

const readDocs = () => native.momoMemory.files();

export function MemoryTab() {
  const [query, setQuery] = useState('');
  const q = query.trim();
  const readFacts = useCallback(() => native.momoMemory.list({ query: q }), [q]);
  const docs = useRead(readDocs);
  const facts = useRead(readFacts);
  const off = docs.off ?? facts.off;
  // an account MoMo isn't open to sees nothing of it
  if (off === 'not_allowed') return null;
  if (off === 'unavailable')
    return (
      <div className="momo-memory">
        <Group title="Memory">
          <Row title="Memory is off" desc="This Mac can't encrypt it right now." />
          <AddFact added={facts.load} disabled />
        </Group>
      </div>
    );
  const d = docs.value;
  const f = facts.value;
  return (
    <div className="momo-memory">
      {docs.error && (
        <div className="config-warning" role="alert">
          Couldn't read: {docs.error}{' '}
          <button className="btn-pill soft" onClick={() => void docs.load()}>
            Retry
          </button>
        </div>
      )}
      {d && (
        <>
          <Group title="About you" desc="Every MoMo chat reads this.">
            <DocEditor name="aboutYou" label="About you" text={d.aboutYou} unreadable={d.unreadable.includes('aboutYou')} />
          </Group>
          <Group title="MoMo's persona" desc="How MoMo talks and works.">
            <DocEditor name="persona" label="MoMo's persona" text={d.persona} unreadable={d.unreadable.includes('persona')} />
          </Group>
        </>
      )}
      <Group
        title="Facts"
        desc="Read as notes, never as instructions."
        action={
          <input
            className="text-input slim"
            type="search"
            aria-label="Search facts"
            placeholder="Search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        }
      >
        <AddFact added={() => void facts.load()} disabled={false} />
        {facts.error && (
          <div className="config-warning" role="alert">
            Couldn't read the facts: {facts.error}{' '}
            <button className="btn-pill soft" onClick={() => void facts.load()}>
              Retry
            </button>
          </div>
        )}
        {f && !!f.unreadable && (
          <div className="config-warning">
            {f.unreadable === 1 ? "1 saved line couldn't be read." : `${f.unreadable} saved lines couldn't be read.`}
          </div>
        )}
        {f && !f.facts.length && <Row title={q ? 'No matching facts' : 'No facts yet'} />}
        {f?.facts.map((fact) => (
          <FactRow key={`${fact.id}:${fact.text}`} fact={fact} now={f.now} changed={() => void facts.load()} />
        ))}
      </Group>
      <OpenLoops />
      <RecentChanges />
      <WrittenChanges />
      <PastFacts />
    </div>
  );
}
