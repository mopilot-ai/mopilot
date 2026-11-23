// A tab's CDP screencast has one start/stop path, browser/screencastLease.cjs (#3752): a recorder that sent Page.startScreencast or Page.stopScreencast itself would end another recorder's frames on the same tab. The in-app browser plugin's pass-through (iabBackend/handlers.cjs) forwards a plugin's own CDP calls and is the one other place that names them.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.join(import.meta.dirname, '..');
const ALLOWED = new Set(['electron/capabilities/browser/screencastLease.cjs', 'electron/capabilities/browser/iabBackend/handlers.cjs']);
const files = (dir: string): string[] =>
  fs
    .readdirSync(dir, { withFileTypes: true })
    .flatMap((e) => (e.isDirectory() ? files(path.join(dir, e.name)) : /\.(cjs|mjs|js|ts)$/.test(e.name) ? [path.join(dir, e.name)] : []));

test('I: only the screencast lease starts or stops a tab screencast', () => {
  const sources = files(path.join(ROOT, 'electron'));
  assert.ok(sources.length > 100, 'the sources were found');
  for (const file of sources) {
    const rel = path.relative(ROOT, file).split(path.sep).join('/');
    if (ALLOWED.has(rel)) continue;
    assert.doesNotMatch(
      fs.readFileSync(file, 'utf8'),
      /Page\.(start|stop)Screencast\b/,
      `${rel} starts or stops a screencast itself: take a lease (browser/screencastLease.cjs) so it cannot end another recorder's`,
    );
  }
  for (const rel of ALLOWED)
    assert.match(fs.readFileSync(path.join(ROOT, rel), 'utf8'), /Page\.(start|stop)Screencast\b/, `${rel} still names the commands`);
});
