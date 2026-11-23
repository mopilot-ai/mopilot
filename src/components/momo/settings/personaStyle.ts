// How MoMo talks, as one line of its persona (memory's persona file, #2159): "Style: warm". Setup reads and changes that line alone; whatever else the user wrote in the persona stays as it is.
import { MOMO_STYLES, type MomoStyle } from '../../../../shared/momoPrefs.mjs';

const LINE = /^Style: (\w+)\s*$/im;

/** The style the persona names, or null when it names none (or one setup doesn't offer). */
export function personaStyle(persona: string): MomoStyle | null {
  const m = LINE.exec(persona);
  const v = m?.[1].toLowerCase();
  return v && (MOMO_STYLES as readonly string[]).includes(v) ? (v as MomoStyle) : null;
}

/** The persona with its style line set to `style`: replaced where it is, else added first. */
export function withPersonaStyle(persona: string, style: MomoStyle): string {
  const line = `Style: ${style}`;
  if (LINE.test(persona)) return persona.replace(LINE, line);
  return persona.trim() ? `${line}\n${persona}` : line;
}
