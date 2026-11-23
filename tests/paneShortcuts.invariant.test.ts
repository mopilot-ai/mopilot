// Every pane that shows a page from a panel session takes the browser pane's page keys: main forwards Cmd +/-/0, Cmd R
// and the rest from the focused page, and only useBrowserShortcuts acts on them, so a pane without it ignores them
// (#2600, the Artifact pane).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

export const GUARDS = ['src/components/'];

const ROOT = path.resolve(import.meta.dirname, '..');
const files = (dir: string): string[] =>
  fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return files(p);
    return /\.tsx$/.test(e.name) ? [p] : [];
  });

test('a component that hosts a page (ViewSurface or <webview>) also calls useBrowserShortcuts', () => {
  const hosts = files(path.join(ROOT, 'src', 'components')).filter((f) => /<(ViewSurface|webview)[\s/]/.test(fs.readFileSync(f, 'utf8')));
  assert.ok(hosts.length >= 2, 'the browser pane and the Artifact pane host pages');
  const missing = hosts.filter((f) => !/\buseBrowserShortcuts\(/.test(fs.readFileSync(f, 'utf8'))).map((f) => path.relative(ROOT, f));
  assert.deepEqual(missing, [], 'these panes show a page whose zoom and reload keys do nothing');
});
