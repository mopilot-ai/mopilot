// Chrome refuses every debugger call on a tab with another extension's frame in it, so each native attach and detach goes through the one wrapper in debuggers.mjs that tells that refusal from a failure (cuj-chrome-foreign-frame): a new call site elsewhere in the extension would hand the refusal to the chat raw.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { treeFiles } from '../scripts/source-tree.mjs';

export const GUARDS = ['electron/chrome-extension/src/'];

const SRC = path.resolve(import.meta.dirname, '../electron/chrome-extension/src');
const files = treeFiles(SRC, /\.mjs$/);
const calls = (re: RegExp) => files.flatMap((f: string) => (fs.readFileSync(f, 'utf8').match(re) ?? []).map(() => path.basename(f)));

test('the extension has one native debugger.attach and one native debugger.detach, both in debuggers.mjs', () => {
  assert.ok(files.length > 10);
  assert.deepEqual(calls(/\.debugger\.attach\(/g), ['debuggers.mjs']);
  assert.deepEqual(calls(/\.debugger\.detach\(/g), ['debuggers.mjs']);
});

test('every native debugger.sendCommand maps the foreign-frame refusal (debuggers.mjs) or is listed with its reason', () => {
  // frameGuard.mjs guardTab: it catches every failure and answers false, so no refusal leaves it
  assert.deepEqual(calls(/\.debugger\.sendCommand\(/g).sort(), ['debuggers.mjs', 'frameGuard.mjs']);
  // the agent's passthrough in sessions.mjs goes through Debuggers.sendCommand
  assert.match(fs.readFileSync(path.join(SRC, 'sessions.mjs'), 'utf8'), /this\.debuggers\.sendCommand\(/);
});

test('only frameGuard.mjs knows what Chrome’s foreign-frame refusal says', () => {
  assert.deepEqual(calls(/different extension/g), ['frameGuard.mjs', 'frameGuard.mjs']);
  assert.deepEqual(
    calls(/FOREIGN_FRAME/g).filter((f: string) => f !== 'frameGuard.mjs'),
    [],
  );
});
