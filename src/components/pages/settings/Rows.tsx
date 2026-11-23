// Settings rows and helpers shared across sections and harness pages: a binary path field and row, inline code, the effort picker, a hotkey field, groupBy.

import { abbreviateHome } from '../../../lib/paths';
import { Row } from './Controls';
import { X, ChevronDown, Pencil } from '../../ui/icons';
import { useEffect, useState } from 'react';
import { useStore, setPrefs } from '../../../store/core';
import { effortLabel } from '../../../lib/format';
import { Menu, MenuItem, useAnchor, Tooltip } from '../../ui/Popover';
import { cancelOnEscape, imeComposing, isEnter } from '../../../lib/focus';
import { withKeys } from '../../../lib/listKeys';
import { prefixUnits, suffixUnits } from '../../../../shared/textPrefix.mjs';

/* ------------------------------------------------------------------ */
/* building blocks                                                     */
/* ------------------------------------------------------------------ */
/**
 * The field a harness's CLI path is typed into: Enter or leaving it saves (empty: found automatically again), Escape
 * puts it back. Opened by a button, so the next keystroke goes here.
 */
export function BinPathInput({
  name,
  value,
  onChange,
  onDone,
}: {
  name: string;
  value: string | null;
  onChange: (v: string | null) => void;
  onDone: () => void;
}) {
  const [draft, setDraft] = useState(value ?? '');
  useEffect(() => setDraft(value ?? ''), [value]);
  const commit = () => {
    const v = draft.trim() || null;
    onDone();
    if (v !== (value ?? null)) onChange(v);
  };
  return (
    <input
      className="text-input slim wide"
      aria-label={`${name} binary path`}
      placeholder={`/path/to/${name}`}
      spellCheck={false}
      autoFocus
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (isEnter(e)) commit();
        else
          cancelOnEscape(e, () => {
            setDraft(value ?? '');
            onDone();
          });
      }}
    />
  );
}

/**
 * Where a harness that isn't installed is looked for: found automatically unless a path was set. The field opens on
 * Change… so the page does not show an empty box nobody needs; Reset goes back to finding it automatically. An
 * installed harness says this in its version row (HarnessVersionRow).
 */
export function BinPathRow({ name, value, onChange }: { name: string; value: string | null; onChange: (v: string | null) => void }) {
  const [editing, setEditing] = useState(false);
  return (
    <Row title="CLI location" desc={value ? abbreviateHome(value) : `Found automatically. Point MoPilot at another ${name}.`}>
      {editing ? (
        <BinPathInput name={name} value={value} onChange={onChange} onDone={() => setEditing(false)} />
      ) : (
        <>
          {value && (
            <button className="btn-pill" onClick={() => onChange(null)}>
              Reset
            </button>
          )}
          <button className="btn-pill" onClick={() => setEditing(true)}>
            Change…
          </button>
        </>
      )}
    </Row>
  );
}

export function shortPath(p: string, max = 28) {
  if (p.length <= max) return p;
  return prefixUnits(p, 13) + '…' + suffixUnits(p, max - 16);
}

/* ------------------------------------------------------------------ */
/* MCP servers & skills (also used by the Customize page)              */
/* ------------------------------------------------------------------ */
export function groupBy<T>(arr: T[], key: (t: T) => string) {
  const out: Record<string, T[]> = {};
  for (const a of arr) (out[key(a)] ??= []).push(a);
  return out;
}

/** Records a global shortcut as an Electron accelerator ("Off" when unset). */
export function HotkeyField({ value, onChange }: { value: string | null; onChange: (acc: string | null) => void }) {
  const [rec, setRec] = useState(false);
  useEffect(() => {
    if (!rec) return;
    const h = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (imeComposing(e)) return;
      if (e.key === 'Escape') return setRec(false);
      if (['Meta', 'Shift', 'Alt', 'Control'].includes(e.key)) return;
      if (!e.metaKey && !e.ctrlKey && !e.altKey) return;
      const key = e.code.startsWith('Key')
        ? e.code.slice(3)
        : e.code.startsWith('Digit')
          ? e.code.slice(5)
          : e.key === ' '
            ? 'Space'
            : e.key.length === 1
              ? e.key.toUpperCase()
              : e.key;
      const acc = [e.ctrlKey && 'Control', e.altKey && 'Alt', e.shiftKey && 'Shift', e.metaKey && 'Command', key].filter(Boolean).join('+');
      setRec(false);
      onChange(acc);
    };
    window.addEventListener('keydown', h, true);
    return () => window.removeEventListener('keydown', h, true);
  }, [rec, onChange]);
  const pretty = (acc: string) =>
    acc.replace('Control+', '⌃').replace('Alt+', '⌥').replace('Shift+', '⇧').replace('Command+', '⌘').replace('Space', 'Space');
  return (
    <span className="hotkey-field">
      {rec ? (
        <span className="kbd-recording">Press keys…</span>
      ) : value ? (
        <kbd>{pretty(value)}</kbd>
      ) : (
        <span className="settings-value">Off</span>
      )}
      <Tooltip label={value ? 'Change' : 'Set shortcut'}>
        <button className="icon-btn xs" onClick={() => setRec((r) => !r)} aria-label="Edit shortcut">
          <Pencil size={13} />
        </button>
      </Tooltip>
      {value && (
        <Tooltip label="Turn off">
          <button className="icon-btn xs" onClick={() => onChange(null)} aria-label="Turn off">
            <X size={13} />
          </button>
        </Tooltip>
      )}
    </span>
  );
}

/** Renders `backtick` spans in warnings as inline code, like the official banner. */
export function InlineCode({ text }: { text: string }) {
  return (
    <>
      {withKeys(text.split(/(`[^`]+`)/), (part) => part).map(({ key, item: part }) =>
        part.startsWith('`') && part.endsWith('`') ? <code key={key}>{part.slice(1, -1)}</code> : <span key={key}>{part}</span>,
      )}
    </>
  );
}

const ALL_EFFORTS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
/** Multi-select of the effort stops shown on the composer's effort slider. */
export function EffortsSelect() {
  const prefs = useStore((s) => s.prefs);
  const a = useAnchor();
  const chosen = prefs.visibleEfforts ?? ['low', 'medium', 'high', 'xhigh', 'max'];
  const toggle = (e: string) => {
    const next = chosen.includes(e) ? chosen.filter((x) => x !== e) : [...chosen, e];
    if (next.length) setPrefs({ visibleEfforts: ALL_EFFORTS.filter((x) => next.includes(x)) });
  };
  return (
    <>
      <button ref={a.ref} className="select-btn" onClick={a.toggle}>
        <span className="select-label">{chosen.length} selected</span>
        <ChevronDown size={14} strokeWidth={2} />
      </button>
      <Menu anchor={a.anchor} open={a.open} onClose={a.close} placement="bottom-end" width={200}>
        {ALL_EFFORTS.map((e) => (
          <MenuItem key={e} checked={chosen.includes(e)} onSelect={() => toggle(e)} keepOpen>
            {effortLabel(e)}
          </MenuItem>
        ))}
      </Menu>
    </>
  );
}
