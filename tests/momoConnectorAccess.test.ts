// A connected account's access level and the sign-in's cancel in the connector hub (electron/momo/connectors/hub.cjs, vault.cjs, #2999 C0), over the test connector (fake.cjs) and MoMo's real loopback sign-in: Pause refuses every call, Read only refuses changes, Read & ask to change sends the level to the trust layer; a pause or MoMo turned off while the card waits refuses the run; a level set while a refresh runs is kept; Cancel ends the browser wait.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fakeSafe, scratch } from './support/momo-fixtures.ts';
import { connectorWorld, tick } from './support/momoConnectorWorld.ts';

const require = createRequire(import.meta.url);
const { TokenVault } = require('../electron/momo/connectors/vault.cjs');

const code = (c: string) => (e: any) => e.code === c;

test('the test connector signs in through the real loopback, its tokens from in-process, and its tools run', async () => {
  const w = connectorWorld();
  const st = await w.connect();
  assert.equal(st.connected, true);
  assert.equal(st.level, 'ask');
  assert.deepEqual(st.scopes, ['notes.read', 'notes.write']);
  assert.match(w.vault.get(w.id).accessToken, /^test-/);
  assert.deepEqual(await w.hub.call({ connector: w.id, tool: 'add', chatId: 'mc', args: { text: 'milk' } }), { added: true });
  await w.hub.call({ connector: w.id, tool: 'add', chatId: 'mc' });
  assert.deepEqual(await w.hub.call({ connector: w.id, tool: 'list', chatId: 'mc' }), { notes: ['milk', ''] });
  assert.deepEqual(
    w.decisions.map((d) => [d.tool, d.kind, d.level, d.summary]),
    [
      ['add', 'change', 'ask', 'Add the note "milk"'],
      ['add', 'change', 'ask', 'Add the note ""'],
      ['list', 'read', 'ask', 'List the test notes'],
    ],
  );
  // an hour on, the token is refreshed in-process before the call
  const before = w.vault.get(w.id).accessToken;
  w.advance(3600_000);
  await w.hub.call({ connector: w.id, tool: 'list', chatId: 'mc' });
  assert.notEqual(w.vault.get(w.id).accessToken, before);
});

test('levels: Pause refuses every call, Read only refuses changes, each refusal audited; Resume asks again', async () => {
  const w = connectorWorld();
  await assert.rejects(w.hub.setLevel(w.id, 'blocked'), code('not_connected'));
  await w.connect();
  await w.hub.setLevel(w.id, 'blocked');
  assert.equal(w.hub.status(w.id).level, 'blocked');
  await assert.rejects(w.hub.call({ connector: w.id, tool: 'list', chatId: 'mc' }), code('refused'));
  assert.equal(w.audits.at(-1).decision, 'paused');
  await w.hub.setLevel(w.id, 'read');
  assert.deepEqual(await w.hub.call({ connector: w.id, tool: 'list', chatId: 'mc' }), { notes: [] });
  await assert.rejects(w.hub.call({ connector: w.id, tool: 'add', chatId: 'mc', args: { text: 'x' } }), code('refused'));
  assert.equal(w.audits.at(-1).decision, 'read only');
  assert.deepEqual(
    w.decisions.map((d) => [d.tool, d.level]),
    [['list', 'read']],
  );
  await w.hub.setLevel(w.id, 'ask');
  await w.hub.call({ connector: w.id, tool: 'add', chatId: 'mc', args: { text: 'x' } });
  assert.equal(w.decisions.at(-1).level, 'ask');
  await assert.rejects(w.hub.setLevel(w.id, 'everything'), /Not an access level/);
});

test('race: a pause, or MoMo turned off, while the card waits refuses the run', async () => {
  let answer: (v: any) => void = () => {};
  const w = connectorWorld({ decide: () => new Promise((r) => (answer = r)) });
  await w.connect();
  const p = w.hub.call({ connector: w.id, tool: 'add', chatId: 'mc', args: { text: 'x' } });
  while (!w.decisions.length) await tick();
  await w.hub.setLevel(w.id, 'blocked');
  answer({ allow: true });
  await assert.rejects(p, code('refused'));
  assert.equal(w.audits.at(-1).decision, 'paused');
  assert.deepEqual(await w.hub.call({ connector: w.id, tool: 'list', chatId: 'mc' }).catch((e: any) => e.code), 'refused');
  // MoMo turned off after the hub's first check, while the token is read: refused before the card
  await w.hub.setLevel(w.id, 'ask');
  const q = w.hub.call({ connector: w.id, tool: 'list', chatId: 'mc' });
  w.s.allowed = false;
  await assert.rejects(q, code('refused'));
  assert.equal(w.audits.at(-1).decision, 'MoMo is off');
});

test('vault: a level is kept by a later save without one (a refresh racing Pause), replaced by one with one, dropped when not a level', async () => {
  const v = new TokenVault({ dir: scratch(), safeStorage: fakeSafe(), now: () => 1 });
  await v.setLevel('x', 'read');
  assert.equal(v.get('x'), null, 'nothing saved: nothing to set');
  await v.put('x', { accessToken: 'a', scopes: [] });
  assert.equal(v.get('x').level, undefined);
  await v.setLevel('x', 'blocked');
  await v.put('x', { accessToken: 'b', scopes: [] });
  assert.deepEqual([v.get('x').accessToken, v.get('x').level], ['b', 'blocked']);
  await v.put('x', { accessToken: 'c', scopes: [], level: 'read' });
  assert.equal(v.get('x').level, 'read');
  await v.put('y', { accessToken: 'c', scopes: [], level: 'all' });
  assert.equal(v.get('y').level, undefined);
  assert.throws(() => v.setLevel('x', 'all'), /Not an access level/);
});

test('cancel: ends the browser wait (the connect rejects as closed); nothing waiting is false', async () => {
  const w = connectorWorld();
  assert.equal(w.hub.cancel(w.id), false);
  const p = w.hub.connect(w.id);
  const settled = assert.rejects(p, (e: any) => e.code === 'closed');
  while (!w.opened.length) await tick();
  assert.equal(w.hub.status(w.id).connecting, true);
  assert.equal(w.hub.cancel(w.id), true);
  await settled;
  assert.equal(w.hub.status(w.id).connected, false);
  assert.equal(w.hub.status(w.id).connecting, false);
  assert.throws(
    () => w.hub.cancel('nope'),
    (e: any) => e.code === 'unknown',
  );
});
