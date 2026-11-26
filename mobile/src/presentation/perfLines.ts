// The performance log's video and pick notes as plain lines: numbers and fixed words only (a size, an outcome, a result), never a name, a path or an id, so a screen reader or a test can read them.
import type { PickNote, UploadNote, UploadPart, VideoNote } from '../perfLog';

const mb = (bytes: number | null) => (bytes === null ? '?' : `${(bytes / (1024 * 1024)).toFixed(1)} MB`);
const secs = (value: number) => `${value} s`;

/** "60 s · 80.0 MB · 3840×2160 · 540p cut est 22.0 MB got 20.0 MB 9.5 s · 480p kept est 15.0 MB got 18.0 MB 7.3 s · → smaller 480p in 17.1 s". */
export function videoLine(note: VideoNote): string {
  const length = note.durationMs === null ? '?' : secs(Math.round(note.durationMs / 100) / 10);
  const dimensions = note.width && note.height ? `${note.width}×${note.height}` : '?';
  const sizes = note.rungs.map(
    (r) => `${r.size} ${r.outcome} est ${mb(r.estimate)} got ${mb(r.bytes)} ${secs(Math.round(r.seconds * 10) / 10)}`,
  );
  const end = `${note.result}${note.kept ? ` ${note.kept}` : ''} in ${secs(note.seconds)}`;
  return [length, mb(note.sourceBytes), dimensions, ...sizes, `→ ${end}`].join(' · ');
}

/** "2 items · 2 videos · picker 43.8 s · ready 5.1 s". */
export const pickLine = (note: PickNote): string =>
  `${note.count} items · ${note.videos} videos · picker ${secs(note.seconds)} · ready ${secs(note.readSeconds)}`;

/** A part's place: its connection and, when it is not the upload's own, the computer it went to. */
const where = (part: UploadPart) => `g${part.gen ?? '?'}${part.computer === 'same' ? '' : ` ${part.computer}`}`;

/**
 * "restarted · computer none · 72 parts · 0–37 ok g4 · 38 lost g4 · 38 other-computer g5 · waits 1 s 2 s · → retry other-computer in 3.2 s": parts that went
 * one after another on the same connection are one range (as the note keeps them); every other part is shown where it happened; the waits taken, in order.
 */
export function uploadLine(note: UploadNote): string {
  const out: string[] = [];
  if (note.restarted) out.push('restarted');
  out.push(`computer ${note.computer}`, `${note.parts} parts`);
  for (const part of note.events) {
    const which = part.to === undefined ? `${part.index}` : `${part.index}–${part.to}`;
    out.push(`${which} ${part.outcome}${part.code ? ` ${part.code}` : ''} ${where(part)}`);
  }
  if (note.waits.length) out.push(`waits ${note.waits.map((w) => secs(Math.round(w / 100) / 10)).join(' ')}`);
  out.push(`→ ${note.result}${note.reason ? ` ${note.reason}` : ''} in ${secs(note.seconds)}`);
  return out.join(' · ');
}
