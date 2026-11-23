// Settings → Shortcuts: rebinding menu actions.

import { SHORTCUT_ACTIONS, effectiveBindings, bindingConflict } from '../../../../shared/shortcuts.mjs';
import { platform } from '../../../lib/platform';
import { ignoring } from '../../../lib/ignored';
import { native } from '../../../lib/native';
import { Group, Row } from './Controls';
import { shortcutLabel } from '../../../lib/platform';
import { Search, Trash2, Pencil } from '../../ui/icons';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useStore } from '../../../store/core';
import { comboFromEvent } from '../../../lib/format';
import { Tooltip } from '../../ui/Popover';
import { imeComposing } from '../../../lib/focus';

/* ------------------------------------------------------------------ */
/* Keyboard shortcuts (editable)                                       */
/* ------------------------------------------------------------------ */
export { SHORTCUT_ACTIONS } from '../../../../shared/shortcuts.mjs';

export function Shortcuts() {
  const prefs = useStore((s) => s.prefs);
  const [q, setQ] = useState('');
  const [recording, setRecording] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const inFlight = useRef(false);
  const save = useCallback(async (id: string, key?: string | null) => {
    if (inFlight.current) return;
    inFlight.current = true;
    setSaving(true);
    setError('');
    try {
      if ((await native.prefs.binding(id, key)) !== true) throw new Error('The shortcut could not be saved.');
      setRecording(null);
    } catch {
      setError('Could not save the shortcut. Try again.');
    } finally {
      inFlight.current = false;
      setSaving(false);
    }
  }, []);
  useEffect(() => {
    if (!recording) return;
    native.prefs.recording(true).catch(() => setError('Could not capture native shortcuts. Try again.'));
    return () => {
      void native.prefs.recording(false).catch(ignoring('stop capturing native shortcuts'));
    };
  }, [recording]);
  useEffect(() => {
    if (!recording || saving) return;
    const h = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (inFlight.current || imeComposing(e)) return;
      if (e.key === 'Escape') return setRecording(null);
      const c = comboFromEvent(e);
      if (!c || e.repeat) return;
      const conflict = bindingConflict(recording, c, prefs.keybindings, platform);
      if (conflict) return setError(`Already used by ${conflict.title}. Remove that binding first.`);
      void save(recording, c);
    };
    window.addEventListener('keydown', h, true);
    return () => window.removeEventListener('keydown', h, true);
  }, [recording, prefs.keybindings, saving, save]);
  const list = SHORTCUT_ACTIONS.filter((a) => !q || a.title.toLowerCase().includes(q.toLowerCase()));
  return (
    <>
      <div className="pill-search wide shortcuts-search">
        <Search size={14} strokeWidth={1.7} />
        <input placeholder="Search shortcuts" value={q} onChange={(e) => setQ(e.target.value)} />
      </div>
      {error && <p role="alert">{error}</p>}
      <Group>
        {list.map((a) => {
          const keys = effectiveBindings(a, prefs.keybindings, platform);
          const key = keys.map((k) => shortcutLabel(k)).join(' / ');
          const conflict = keys.map((k) => bindingConflict(a.id, k, prefs.keybindings, platform)).find(Boolean);
          return (
            <Row key={a.id} title={a.title} desc={conflict ? `Also assigned to ${conflict.title}` : a.desc}>
              {recording === a.id ? (
                <span className="kbd-recording">Press keys…</span>
              ) : key ? (
                <kbd>{key}</kbd>
              ) : (
                <span className="settings-value">Unassigned</span>
              )}
              <Tooltip label="Edit shortcut">
                <button
                  className="icon-btn xs"
                  aria-label="Edit shortcut"
                  disabled={saving}
                  onClick={() => {
                    if (inFlight.current) return;
                    setError('');
                    setRecording(a.id);
                  }}
                >
                  <Pencil size={13} />
                </button>
              </Tooltip>
              {Object.hasOwn(prefs.keybindings, a.id) && (
                <button className="btn xs" disabled={saving} onClick={() => void save(a.id)}>
                  Restore default
                </button>
              )}
              {key && (
                <Tooltip label="Remove shortcut">
                  <button className="icon-btn xs" aria-label="Remove shortcut" disabled={saving} onClick={() => void save(a.id, null)}>
                    <Trash2 size={13} />
                  </button>
                </Tooltip>
              )}
            </Row>
          );
        })}
      </Group>
    </>
  );
}
