// The phone never tells a person to refresh a chat: it reads again by itself, and a failed read offers Retry.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

const root = path.join(import.meta.dirname, '..', 'mobile', 'src');
const files = (dir: string): string[] =>
  fs
    .readdirSync(dir, { withFileTypes: true })
    .flatMap((e) => (e.isDirectory() ? files(path.join(dir, e.name)) : /\.(ts|tsx)$/.test(e.name) ? [path.join(dir, e.name)] : []));

test('no phone copy says Refresh the chat, Refresh chat or Earlier activity changed', () => {
  const found = files(root).filter((f) => /Refresh (the )?chat|Earlier activity changed/.test(fs.readFileSync(f, 'utf8')));
  assert.deepEqual(
    found.map((f) => path.relative(root, f)),
    [],
  );
});
