// Setup's first screen (#2607): "Meet {name}": MoMo's big dot in the color being tried, one line of intro, its name (prefs.momo.persona.name, MoMo by default), five color swatches (prefs.momo.persona.color) and Continue, which saves both. The brain is chosen for the user (BrainRow.tsx's default) and said only in a muted footnote; nothing here asks about harnesses or can be skipped.
import { useState } from 'react';
import type { MomoColor, MomoRoleBrain } from '../../../../shared/momoPrefs.mjs';
import { isEnter } from '../../../lib/focus';
import { saveMomoPref, useMomoPrefs } from '../../../session/momoPrefs';
import { MOMO_COLOR_OPTIONS } from '../momoColors';
import { NoBrain, brainText } from './BrainRow';
import { Orb } from './Orb';

const NAME_MAX = 40;
const DEFAULT_NAME = 'MoMo';

export function MeetStep({
  brain,
  ready,
  allLimited,
  onDone,
}: {
  brain: MomoRoleBrain | null;
  /** the brain's model is known, or has been waited for long enough */
  ready: boolean;
  allLimited: boolean;
  onDone: (name: string) => void;
}) {
  const saved = useMomoPrefs().persona;
  const [name, setName] = useState(saved.name);
  const [color, setColor] = useState<MomoColor>(saved.color);
  const [busy, setBusy] = useState(false);
  const shown = name.trim() || DEFAULT_NAME;
  // one move at a time: Continue waits for both to be saved (each tells the user when it was not)
  const next = async () => {
    setBusy(true);
    const ok =
      (shown === saved.name || (await saveMomoPref('persona.name', shown))) &&
      (color === saved.color || (await saveMomoPref('persona.color', color)));
    setBusy(false);
    if (ok) onDone(shown);
  };
  return (
    <section className="momo-setup-main momo-meet" aria-labelledby="momo-meet-title">
      <Orb size={88} color={color} />
      <div className="momo-meet-intro">
        <h1 className="momo-setup-title momo-meet-title" id="momo-meet-title">
          Meet {shown}
        </h1>
        <p className="momo-setup-lead">Your personal agent. It remembers what matters to you and helps with your day.</p>
      </div>
      <div className="momo-meet-field">
        <label htmlFor="momo-name">Name</label>
        <input
          id="momo-name"
          className="text-input lg"
          value={name}
          maxLength={NAME_MAX}
          placeholder={DEFAULT_NAME}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => isEnter(e) && brain && ready && !busy && void next()}
        />
      </div>
      <div className="momo-meet-field" role="radiogroup" aria-label="Color">
        <span>Color</span>
        <div className="momo-swatches">
          {MOMO_COLOR_OPTIONS.map((c) => (
            <button
              key={c.id}
              type="button"
              role="radio"
              aria-checked={c.id === color}
              aria-label={c.label}
              className="momo-swatch"
              style={{ ['--swatch' as string]: c.css }}
              onClick={() => setColor(c.id)}
            />
          ))}
        </div>
      </div>
      {brain ? (
        <div className="momo-setup-foot momo-meet-foot">
          <button
            type="button"
            className="btn primary lg"
            disabled={busy || !ready}
            aria-busy={!ready || undefined}
            onClick={() => void next()}
          >
            Continue
          </button>
          <p className="momo-setup-note">Thinks with {brainText(brain)}. You can change this in Settings.</p>
        </div>
      ) : (
        <NoBrain allLimited={allLimited} />
      )}
    </section>
  );
}
