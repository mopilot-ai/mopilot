// Every wire method a feature declares in `shared/host/methods/` has a Host handler in `host/src/methods/` and the other way round, says whether it needs a paired client, and both folders are packed into the Host archive.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createRequire } from 'node:module';
import { FEATURES, FOLDER_PAIRED_ONLY, PARSERS, REQUIRES } from '../shared/host/schema.mjs';
import { codeFilesIn, defaultOf } from '../shared/host/methodFiles.mjs';
import { loadHandlers } from '../host/src/methodHandlers.mjs';

const require = createRequire(import.meta.url);
const root = path.resolve(import.meta.dirname, '..');
const { hostFiles } = require('../electron/host/bundle.cjs');
const declared = Object.fromEntries(
  codeFilesIn(path.join(root, 'shared/host/methods')).flatMap((f) => {
    const file = defaultOf(require(`../shared/host/methods/${f}`));
    const made = typeof file === 'function' ? file({ bad: String, matchOf: String }) : file;
    return Object.entries(made.methods).map(([m, d]: [string, any]) => [m, { ...d, features: made.features ?? [], file: f }]);
  }),
);

test('each declared method is parsed, gated on its features and paired as its file says', () => {
  for (const [method, d] of Object.entries<any>(declared)) {
    assert.equal(typeof PARSERS[method], 'function', method);
    assert.deepEqual((REQUIRES as any)[method] ?? [], d.requires ?? [], method);
    assert.equal(FOLDER_PAIRED_ONLY.includes(method), d.access === 'paired', method);
    for (const f of d.requires ?? []) assert.ok(FEATURES.includes(f), `${method} needs ${f}, which no file declares`);
  }
});

test('a method of the folders has a handler and a handler has a declared method, even on a Host given nothing', () => {
  const { handlers, effects } = loadHandlers({});
  assert.deepEqual([...Object.keys(handlers), ...Object.keys(effects)].sort(), Object.keys(declared).sort());
});

test('a method of the folders is one the server hands to the protocol session: its name starts with host, chat, browser or desktop (host/src/server.mjs), or the server would answer Unknown method', () => {
  for (const method of Object.keys(declared)) assert.match(method, /^(host|chat|browser|desktop)\./, method);
});

test('the Host archive packs both folders', () => {
  const packed = hostFiles(root);
  for (const f of codeFilesIn(path.join(root, 'shared/host/methods'))) assert.ok(packed.includes(`shared/host/methods/${f}`), f);
  for (const f of codeFilesIn(path.join(root, 'host/src/methods'))) assert.ok(packed.includes(`host/src/methods/${f}`), f);
});
