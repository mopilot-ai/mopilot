// Every pane that shows a page from a panel session shows that page's downloads: a download there saves silently, so a
// pane without the Downloads button and notice slot makes the file look lost (#2595, the Artifact pane).
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

test('a component that hosts a page (ViewSurface or <webview>) also renders BrowserDownloads and its notice slot', () => {
  const hosts = files(path.join(ROOT, 'src', 'components')).filter((f) => /<(ViewSurface|webview)[\s/]/.test(fs.readFileSync(f, 'utf8')));
  assert.ok(hosts.length >= 2, 'the browser pane and the Artifact pane host pages');
  const missing = hosts
    .filter((f) => {
      const src = fs.readFileSync(f, 'utf8');
      return !/<BrowserDownloads\b/.test(src) || !/className=\{NOTICE_SLOT\}/.test(src);
    })
    .map((f) => path.relative(ROOT, f));
  assert.deepEqual(missing, [], 'these panes show a page whose downloads nobody would see');
});
