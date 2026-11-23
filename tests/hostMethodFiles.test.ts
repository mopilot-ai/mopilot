// The loaders that find a Host wire method by its own file (shared/host/methodFiles.mjs, host/src/methodHandlers.mjs): the declaration checks, the order, and what a folder that is missing or holds other files gives.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { codeFilesIn, collectMethodFiles, defaultOf } from '../shared/host/methodFiles.mjs';
import { collectHandlers, loadHandlers } from '../host/src/methodHandlers.mjs';

const parse = (p: any) => p;
const decl = (methods: Record<string, any>, features?: string[]) => ({ features, methods });
const collect = (files: Record<string, unknown>, taken = (_m: string) => false, kit = {}) =>
  collectMethodFiles(Object.keys(files), (n) => files[n], kit, taken);

test('a folder lists its code files in order and nothing else; a missing folder lists none', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'methods-'));
  for (const n of ['b.mjs', 'a.cjs', 'c.js', 'x.d.mts', 'notes.md']) fs.writeFileSync(path.join(dir, n), '');
  assert.deepEqual(codeFilesIn(dir), ['a.cjs', 'b.mjs', 'c.js']);
  assert.deepEqual(codeFilesIn(path.join(dir, 'missing')), []);
});

test('a declaration is an object or a function of the kit, and an import or a require gives its default', () => {
  assert.equal(defaultOf({ default: 7 }), 7);
  assert.equal(defaultOf(7), 7);
  assert.equal(defaultOf(null), null);
  const got = collect({ 'a.mjs': { default: (kit: any) => decl({ 'x.one': { access: 'paired', parse: () => kit.k } }) } }, undefined, {
    k: 5,
  });
  assert.equal(got.parsers['x.one']({}), 5);
  assert.deepEqual(got.paired, ['x.one']);
});

test('declarations merge: features once, requires only where given, paired only where declared', () => {
  const got = collect({
    'a.mjs': decl({ 'a.one': { access: 'paired', parse, requires: ['f1'] }, 'a.two': { access: 'open', parse, requires: [] } }, [
      'f1',
      'f2',
    ]),
    'b.mjs': decl({ 'b.one': { access: 'paired', parse } }, ['f2', 'f3']),
  });
  assert.deepEqual(Object.keys(got.parsers), ['a.one', 'a.two', 'b.one']);
  assert.deepEqual(got.requires, { 'a.one': ['f1'] });
  assert.deepEqual(got.features, ['f1', 'f2', 'f3']);
  assert.deepEqual(got.paired, ['a.one', 'b.one']);
});

test('a mistaken declaration stops the module from loading', () => {
  assert.throws(() => collect({ 'a.mjs': null }), /methods\/a.mjs declares no methods/);
  assert.throws(() => collect({ 'a.mjs': { methods: 3 } }), /declares no methods/);
  assert.throws(() => collect({ 'a.mjs': decl({ 'x.a': { access: 'paired' } }) }), /x.a no parser/);
  assert.throws(() => collect({ 'a.mjs': decl({ 'x.a': { parse } }) }), /say whether x.a is paired or open/);
  assert.throws(
    () => collect({ 'a.mjs': decl({ 'x.a': { access: 'paired', parse } }), 'b.mjs': decl({ 'x.a': { access: 'paired', parse } }) }),
    /already declared/,
  );
  assert.throws(() => collect({ 'a.mjs': decl({ 'x.a': { access: 'paired', parse } }) }, (m) => m === 'x.a'), /already declared/);
});

test('handlers and effects are made from the dependencies and may not be served twice', () => {
  const got = collectHandlers(
    ['a.mjs', 'b.mjs', 'c.mjs'],
    (n) =>
      ({
        'a.mjs': { default: (d: any) => ({ handlers: { 'x.a': () => d.v }, effects: { 'x.b': () => 2 } }) },
        'b.mjs': () => undefined,
        'c.mjs': () => ({}),
      })[n],
    { v: 1 },
  );
  assert.equal(got.handlers['x.a']({}), 1);
  assert.equal(got.effects['x.b']({}), 2);
  const twice = (a: any, b: any) => collectHandlers(['a', 'b'], (n) => (n === 'a' ? () => a : () => b), {});
  assert.throws(() => twice({ handlers: { 'x.a': 1 } }, { handlers: { 'x.a': 1 } }), /already served/);
  assert.throws(() => twice({ handlers: { 'x.a': 1 } }, { effects: { 'x.a': 1 } }), /already served/);
  assert.throws(() => twice({ effects: { 'x.a': 1 } }, { handlers: { 'x.a': 1 } }), /already served/);
});

test('the Host finds its own folder: the relay handlers are there, and refuse when the Host has no relay; the chat writes of its folder are the goal, the switch, the login pin and the rename', () => {
  const { handlers, effects } = loadHandlers({});
  // a feature that adds its own file adds its methods here without editing this list
  const found = Object.keys(handlers);
  for (const m of [
    'host.auditRead',
    'host.chats',
    'host.clientAdd',
    'host.clientRemove',
    'host.clientRename',
    'host.clients',
    'host.commands',
    'host.gitBranches',
    'host.gitCommit',
    'host.gitDiscard',
    'host.gitSwitch',
    'host.gitTurnDiff',
    'host.relayEnroll',
    'host.relayForget',
    'host.relayStatus',
  ])
    assert.ok(found.includes(m), m);
  assert.ok(found.every((m) => typeof handlers[m] === 'function'));
  assert.deepEqual(Object.keys(effects).sort(), ['chat.goal', 'chat.login', 'chat.rename', 'chat.switch']);
  assert.throws(() => handlers['host.relayStatus']({}), /cannot be reached through a relay/);
  const relay = { enroll: (p: any) => ['enroll', p], forget: (p: any) => ['forget', p], status: () => 'status' };
  const served = loadHandlers({ relay }).handlers;
  assert.deepEqual(served['host.relayEnroll']({ a: 1 }), ['enroll', { a: 1 }]);
  assert.deepEqual(served['host.relayForget']({ b: 2 }), ['forget', { b: 2 }]);
  assert.equal(served['host.relayStatus']({}), 'status');
});

test('each handler of the Host’s methods folder is one its own feature’s file declares (shared/host/methods/<same name>), so none is registered from a file of another feature', () => {
  const req = createRequire(import.meta.url);
  const root = path.join(import.meta.dirname, '..');
  const hostDir = path.join(root, 'host', 'src', 'methods');
  const sharedDir = path.join(root, 'shared', 'host', 'methods');
  // a declaration only uses the parser kit inside its parsers, so a kit of identity functions is enough to read the names
  const kit = new Proxy(
    {},
    {
      get:
        () =>
        (...a: unknown[]) =>
          a[0],
    },
  );
  const files = codeFilesIn(hostDir);
  assert.ok(files.includes('relay.mjs'));
  for (const name of files) {
    assert.ok(fs.existsSync(path.join(sharedDir, name)), `${name} has a declaration of the same name`);
    const declared = Object.keys(
      collectMethodFiles(
        [name],
        (n) => req(path.join(sharedDir, n)),
        kit,
        () => false,
      ).parsers,
    );
    const served = defaultOf(req(path.join(hostDir, name)))({});
    for (const method of [...Object.keys(served.handlers ?? {}), ...Object.keys(served.effects ?? {})])
      assert.ok(declared.includes(method), `${method} is served by methods/${name}, which does not declare it`);
  }
});
