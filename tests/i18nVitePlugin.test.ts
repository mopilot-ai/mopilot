// The Vite plugin (scripts/i18n/vitePlugin.mjs): it wraps renderer sources while they are still TSX, and nothing else.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { i18nPlugin } from '../scripts/i18n/vitePlugin.mjs';

const plugin = () => {
  const p: any = i18nPlugin();
  p.configResolved({ root: '/repo' });
  return p;
};
const SOURCE = 'export const V = () => <b>Hello there</b>;';

test('it runs before the compiler, and the React plugin after it', () => assert.equal(plugin().enforce, 'pre'));

test('a renderer source gets lookups from the runtime, by a path relative to it', () => {
  const out = plugin().transform(SOURCE, '/repo/src/components/a/b.tsx?v=1');
  assert.match(out.code, /__t\("Hello there"\)/);
  assert.match(out.code, /from "\.\.\/\.\.\/lib\/i18n\.ts"/);
  assert.match(plugin().transform("toast('Saved it')", '/repo/src/lib/b.ts').code, /from "\.\/i18n\.ts"/);
  assert.equal(out.map, null);
});

test('without a root set it reads the working folder', () => {
  const p: any = i18nPlugin();
  assert.equal(p.transform(SOURCE, '/elsewhere/a.tsx'), null);
});

test('sources outside the renderer, the runtime itself and files with no text are left to the next plugin', () => {
  for (const [code, id] of [
    [SOURCE, '/repo/node_modules/x/a.tsx'],
    [SOURCE, '/repo/electron/a.tsx'],
    [SOURCE, '/repo/src/lib/i18n.ts'],
    ['body{}', '/repo/src/a.css'],
    ['export const a = 1;', '/repo/src/a.ts'],
  ])
    assert.equal(plugin().transform(code, id), null, id);
});
