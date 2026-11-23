// Settings › MoMo › Brain › Name and style (#2139, moved out of setup by #2527): the name MoMo is shown by (prefs.momo.persona.name, saved through main; MoMo by default) and how it talks, one line of its persona in memory (window.native.momoMemory, #2159; personaStyle.ts), read again whenever memory changes.
import { useEffect, useRef, useState } from 'react';
import type { MomoStyle } from '../../../../shared/momoPrefs.mjs';
import { saveMomoPref, useMomoPrefs } from '../../../session/momoPrefs';
import { momoMemoryBridge, type MomoMemoryBridge } from '../../../lib/momoBridges';
import { isEnter } from '../../../lib/focus';
import { toastFailure } from '../../../store/core';
import { Group, Row, Segmented } from '../../pages/settings/Controls';
import { personaStyle, withPersonaStyle } from './personaStyle';

const STYLES: { value: MomoStyle; label: string }[] = [
  { value: 'concise', label: 'Concise' },
  { value: 'warm', label: 'Warm' },
  { value: 'detailed', label: 'Detailed' },
];
const NAME_MAX = 40;

/** A memory answer's value, or its error thrown. */
const value = async <T extends object>(r: Promise<{ ok: true } & T> | Promise<({ ok: true } & T) | { ok: false; error: string }>) => {
  const v = await r;
  if (!v.ok) throw new Error(v.error);
  return v;
};

/** The style line of MoMo's persona; the latest read or change wins. */
function StyleField({ memory }: { memory: MomoMemoryBridge }) {
  const [style, setStyle] = useState<MomoStyle>('concise');
  const [busy, setBusy] = useState(false);
  const gen = useRef(0);
  useEffect(() => {
    let alive = true;
    const read = () => {
      const mine = ++gen.current;
      value(memory.files()).then(
        (r) => alive && mine === gen.current && setStyle(personaStyle(r.persona) ?? 'concise'),
        (e) => alive && mine === gen.current && toastFailure("Couldn't read MoMo's persona")(e),
      );
    };
    read();
    const off = memory.onChanged(read);
    return () => {
      alive = false;
      off();
    };
  }, [memory]);
  /** The persona as saved now with its style line changed, so the rest the user wrote stays. */
  const pick = async (next: MomoStyle) => {
    setBusy(true);
    try {
      const { persona } = await value(memory.files());
      await value(memory.writeFile('persona', withPersonaStyle(persona, next)));
      gen.current++;
      setStyle(next);
    } catch (e) {
      toastFailure("Couldn't save MoMo's style")(e);
    }
    setBusy(false);
  };
  return <Segmented<MomoStyle> label="Style" value={style} options={STYLES} onChange={(s) => void (!busy && pick(s))} />;
}

export function NameStyleSettings() {
  const { persona } = useMomoPrefs();
  const memory = momoMemoryBridge();
  const [name, setName] = useState(persona.name);
  // a name saved elsewhere (another window) shows here
  useEffect(() => setName(persona.name), [persona.name]);
  /** Saved once the field is left; an empty name goes back to the saved one. */
  const commit = async () => {
    const next = name.trim();
    if (!next) return setName(persona.name);
    if (next !== persona.name && !(await saveMomoPref('persona.name', next))) setName(persona.name);
  };
  return (
    <Group title="Name and style" desc="What MoMo is called and how it talks to you.">
      <Row title="Name">
        <input
          className="text-input slim"
          aria-label="Name"
          value={name}
          maxLength={NAME_MAX}
          onChange={(e) => setName(e.target.value)}
          onBlur={() => void commit()}
          onKeyDown={(e) => isEnter(e) && e.currentTarget.blur()}
        />
      </Row>
      <Row title="Style" desc={memory ? undefined : 'Comes with MoMo’s memory, not in this build'}>
        {memory ? <StyleField memory={memory} /> : null}
      </Row>
    </Group>
  );
}
