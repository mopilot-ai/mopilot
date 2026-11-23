// Helpers for the transcript writer tests: temp folders, gates and reading what reached the disk.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function dir(t: any) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'transcript-writer-'));
  t.after(() => fs.rmSync(d, { recursive: true, force: true }));
  return d;
}

/** A deferred promise. */
export function gate() {
  let open!: () => void;
  const p = new Promise<void>((r) => (open = r));
  return { p, open };
}

export const lines = (...xs: string[]) => xs.map((x) => `${JSON.stringify({ x })}\n`);
export const disk = (file: string) => fs.readFileSync(file, 'utf8');
