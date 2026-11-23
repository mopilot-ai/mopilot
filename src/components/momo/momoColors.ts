// MoMo's colors (#2607): the five a user picks in setup (prefs.momo.persona.color, shared/momoPrefs.mjs MOMO_COLORS), each as the app's own token so light and dark both draw it; the sidebar dot, the chat's avatar and setup's big dot read them here.
import type { MomoColor } from '../../../shared/momoPrefs.mjs';

/** The swatches in the order setup lists them; `css` is a token (momo.css defines the one that has none). */
export const MOMO_COLOR_OPTIONS: readonly { id: MomoColor; label: string; css: string }[] = [
  { id: 'clay', label: 'Clay', css: 'var(--accent)' },
  { id: 'blue', label: 'Blue', css: 'var(--momo-blue)' },
  { id: 'green', label: 'Green', css: 'var(--green)' },
  { id: 'violet', label: 'Violet', css: 'var(--purple)' },
  { id: 'ink', label: 'Ink', css: 'var(--text)' },
];

const CSS = Object.fromEntries(MOMO_COLOR_OPTIONS.map((c) => [c.id, c.css])) as Record<MomoColor, string>;

/** The CSS color of a saved color id (prefs only ever hold one of the five). */
export const momoColorCss = (id: MomoColor): string => CSS[id];
