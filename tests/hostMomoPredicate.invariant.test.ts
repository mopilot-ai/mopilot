// Whole-repository invariant for MoMo's chats on a Host: one predicate says which chats are MoMo's (host/src/momoChats.mjs `isMomoChat`: the id's form, the record's tag or the registry), and every decision that depends on it (the veil, the isolation, the tool scope and gate, the tools' visibility) asks it. No other module of the Host reads a chat record's `momo` tag, so no path can ask the record alone and take a MoMo chat whose record is missing or untagged for a coding chat.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

export const GUARDS = ['host/src/'];

const SRC = path.join(import.meta.dirname, '..', 'host', 'src');
const DECIDES = /\b(isMomoMeta|isMomoDataMeta|MOMO_META_KEY|isolateChatTools)\b|\.meta\??\.momo\b|meta\[['"]momo['"]\]/;

const filesUnder = (dir: string): string[] =>
  fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = path.join(dir, e.name);
    return e.isDirectory() ? filesUnder(full) : /\.(?:mjs|cjs|js)$/.test(e.name) ? [full] : [];
  });

test('no module of the Host decides whether a chat is MoMo’s except momoChats.mjs', () => {
  const files = filesUnder(SRC);
  assert.ok(
    files.some((f) => f.endsWith('momoChats.mjs')) && files.some((f) => f.endsWith('momoTools.mjs')),
    'the scan found the Host’s MoMo modules',
  );
  const found = files
    .filter((f) => DECIDES.test(fs.readFileSync(f, 'utf8').replace(/^\s*(\/\/|\*|\/\*\*).*$/gm, '')))
    .map((f) => path.relative(path.join(SRC, '..', '..'), f));
  assert.deepEqual(found, ['host/src/momoChats.mjs'], 'a Host module asks `isMomoChat`, never the record');
});
