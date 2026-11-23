// Every HTML file preview inlines its same-folder files first: an opaque srcdoc sandbox cannot fetch a relative stylesheet or image.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

const root = new URL('..', import.meta.url).pathname;
const src = join(root, 'src');

const files = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? files(join(dir, e.name)) : /\.tsx?$/.test(e.name) ? [join(dir, e.name)] : [],
  );

/** The code with comments removed, so a mention in prose never counts. */
const code = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');

test('each component that builds an HTML preview document passes the file through useLocalAssets', () => {
  const users = files(src).filter(
    (file) => !file.endsWith('src/lib/visualization.ts') && /\bpreviewDocument\(/.test(code(readFileSync(file, 'utf8'))),
  );
  assert.ok(users.length >= 2, 'the file pane and inline visualizations both preview HTML');
  const missing = users.filter((file) => !/\buseLocalAssets\(/.test(code(readFileSync(file, 'utf8')))).map((file) => relative(root, file));
  assert.deepEqual(missing, [], 'a srcdoc preview of a file shows it without the stylesheets and images beside it (black SVG boxes)');
});
