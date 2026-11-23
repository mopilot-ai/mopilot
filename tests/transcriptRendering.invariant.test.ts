// Transcript text must render without waiting for a later frame: no `content-visibility` on transcript content (#1229).
// A turn that becomes `content-visibility: auto` stays skipped until an intersection check in the next rendering update;
// in a window that produces no frames (occluded, or in the background) its text is never laid out, so `innerText` and
// anything reading the rendered text get nothing. Windowed history unmounts far turns instead.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

export const GUARDS = ['src/'];

function files(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    return e.isDirectory() ? files(p) : /\.(css|tsx?)$/.test(e.name) ? [p] : [];
  });
}

test('no stylesheet or component in src/ sets content-visibility', () => {
  const offenders = files('src').filter((f) => /content-visibility|contentVisibility/.test(fs.readFileSync(f, 'utf8')));
  assert.deepEqual(offenders, []);
});
