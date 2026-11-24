// The wire of pairing by code, the controlled Host's side (shared/host/methods/codePair.mjs, host/src/methods/codePair.mjs, host/src/offeredFeatures.mjs, R2b of #5576): what a request may say, who may make it (the CLI on this machine, nobody else), and that a Host built without the service does not offer it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
// @ts-ignore: plain ESM without declarations
import { parseParams, helloParams } from '../shared/host/schema.mjs';
// @ts-ignore
import methodsOf from '../host/src/methods/codePair.mjs';
// @ts-ignore
import { offeredFeatures } from '../host/src/offeredFeatures.mjs';
import { servedHost } from './support/hostClientsWorld.ts';

const ID = `r_${'A'.repeat(22)}`;

test('a request says what it needs and no more: a relay address, a token, an offer, allow or not, a bounded approval', () => {
  assert.deepEqual(parseParams('host.codePair.offer', { relayUrl: 'https://relay.example/', token: 't' }), {
    relayUrl: 'https://relay.example',
    token: 't',
  });
  assert.deepEqual(parseParams('host.codePair.offer', { relayUrl: 'http://127.0.0.1:8080', token: 't' }).relayUrl, 'http://127.0.0.1:8080');
  for (const bad of [
    { relayUrl: 'http://relay.example', token: 't' },
    { relayUrl: 'ftp://relay.example', token: 't' },
    { relayUrl: 'https://u:p@relay.example', token: 't' },
    { relayUrl: 'https://relay.example/path', token: 't' },
    { relayUrl: 7, token: 't' },
    { relayUrl: `https://${'a'.repeat(2100)}`, token: 't' },
    { relayUrl: 'https://relay.example', token: '' },
    { relayUrl: 'https://relay.example', token: 'x'.repeat(4097) },
    { relayUrl: 'https://relay.example' },
  ])
    assert.throws(() => parseParams('host.codePair.offer', bad), { code: 'invalid' }, JSON.stringify(bad).slice(0, 60));
  assert.deepEqual(parseParams('host.codePair.answer', { offerId: ID, accept: true, approval: { sig: 'x' } }), {
    offerId: ID,
    accept: true,
    approval: { sig: 'x' },
  });
  assert.deepEqual(parseParams('host.codePair.answer', { offerId: ID, accept: false }), { offerId: ID, accept: false });
  for (const bad of [
    { offerId: ID, accept: 'yes' },
    { offerId: 'nope', accept: true },
    { offerId: ID, accept: true, approval: 'x' },
    { offerId: ID, accept: true, approval: [1] },
    { offerId: ID, accept: true, approval: { big: 'x'.repeat(1500) } },
  ])
    assert.throws(() => parseParams('host.codePair.answer', bad), { code: 'invalid' }, JSON.stringify(bad).slice(0, 60));
  assert.deepEqual(parseParams('host.codePair.cancel', { offerId: ID }), { offerId: ID });
  assert.throws(() => parseParams('host.codePair.cancel', { offerId: 'r_x' }), { code: 'invalid' });
  assert.deepEqual(parseParams('host.codePair.status', {}), {});
});

test("only the CLI on this machine reaches the service, the connection that calls is the offer's owner, and a Host with no service says so", () => {
  const calls: any[] = [];
  const service = {
    offer: (p: any, who: any) => (calls.push(['offer', p, who]), { offerId: ID }),
    answer: (p: any, who: any) => (calls.push(['answer', p, who]), { accepted: false }),
    cancel: (p: any, who: any) => (calls.push(['cancel', p, who]), { cancelled: true }),
    status: (who: any) => (calls.push(['status', who]), { offers: [] }),
  };
  const { handlers } = methodsOf({ codePair: service as any });
  const ends = new Set<() => void>();
  const emit = () => undefined;
  assert.deepEqual(handlers['host.codePair.offer']({ relayUrl: 'u', token: 't' }, 'cli', {}, emit, ends), { offerId: ID });
  handlers['host.codePair.answer']({ offerId: ID }, 'cli', {}, emit, ends);
  handlers['host.codePair.cancel']({ offerId: ID }, 'cli', {}, emit, ends);
  handlers['host.codePair.status']({}, 'cli', {}, emit, ends);
  assert.equal(calls[0][2].owner, ends, "the connection's own set is the owner");
  assert.equal(calls[0][2].emit, emit);
  assert.deepEqual(
    calls.slice(1).map((c) => [c[0], (c.at(-1) as any).owner === ends]),
    [
      ['answer', true],
      ['cancel', true],
      ['status', true],
    ],
  );
  for (const kind of ['desktop', 'phone', 'controller', 'home', 'unknown', undefined])
    for (const m of Object.keys(handlers))
      assert.throws(() => handlers[m]({}, kind, {}, emit, ends), { code: 'unsupported' }, `${kind} ${m}`);
  const none = methodsOf({}).handlers;
  for (const m of Object.keys(none)) assert.throws(() => none[m]({}, 'cli', {}, emit, ends), { code: 'unsupported' }, m);
});

test('the feature is offered only by a Host that has the service', () => {
  const all = ['hostRead', 'codePair', 'chatList'];
  assert.deepEqual(offeredFeatures(all, { dataDir: '/d', codePair: {} }), all);
  assert.deepEqual(offeredFeatures(all, { dataDir: '/d' }), ['hostRead', 'chatList']);
});

test('on a served Host the CLI is served and a paired desktop is refused, with the feature in the hello only when the Host has the service', async (t) => {
  const service = {
    offer: () => ({ offerId: ID, code: 'ABCD-EFGH', expiresAt: 1 }),
    answer: () => ({ accepted: false }),
    cancel: () => ({ cancelled: true }),
    status: () => ({ offers: [] }),
  };
  const w = await servedHost(t, { codePair: service });
  const token = fs.readFileSync(`${w.paths.socketPath}.token`, 'utf8');
  const cli = w.line();
  const hello = await cli.call('host.hello', helloParams(), token);
  assert.ok(hello.result.features.includes('codePair'));
  const offered = await cli.call('host.codePair.offer', { relayUrl: 'https://relay.example', token: 't' }, token);
  assert.equal(offered.result.code, 'ABCD-EFGH');
  assert.deepEqual((await cli.call('host.codePair.status', {}, token)).result, { offers: [] });
  cli.close();
  const desk = await w.paired('desk', 'Desk');
  const refused = await desk.conn.call('host.codePair.offer', { relayUrl: 'https://relay.example', token: 't' });
  assert.match(String(refused.error), /Unknown request: host\.codePair\.offer/, 'to a desktop the method is one no Host knows');
  const deskHello: any = await desk.conn.call('host.hello', helloParams());
  assert.ok(Array.isArray(deskHello.result.features), "a desktop's hello lists features (as the CLI's does)");
  assert.ok(!deskHello.result.features.includes('codePair'), 'and the hello does not name the feature');
  const bare = await servedHost(t);
  const cli2 = bare.line();
  const token2 = fs.readFileSync(`${bare.paths.socketPath}.token`, 'utf8');
  assert.ok(!(await cli2.call('host.hello', helloParams(), token2)).result.features.includes('codePair'));
  cli2.close();
});

test('the text to approve and the key enrolment name an offer or a key and nothing more', () => {
  assert.deepEqual(parseParams('host.codePair.approvalText', { offerId: ID }), { offerId: ID });
  assert.throws(() => parseParams('host.codePair.approvalText', { offerId: 'nope' }));
  const key = `${'A'.repeat(86)}=`;
  assert.deepEqual(parseParams('host.codePair.enrol', { key, weak: true, signature: 'AAAA' }), { key, weak: true, signature: 'AAAA' });
  for (const bad of [
    { key, signature: 'AAAA' },
    { key: 5, weak: false, signature: 'AAAA' },
    { key, weak: false, signature: 'not base64!' },
    { key: 'A'.repeat(300), weak: false, signature: 'AAAA' },
  ])
    assert.throws(() => parseParams('host.codePair.enrol', bad), Error, JSON.stringify(bad));
});

test("the handlers for the text and the enrolment are the CLI's only, like the rest", () => {
  const calls: any[] = [];
  const codePair = {
    approvalText: (p: any, w: any) => (calls.push(['text', p, typeof w.owner]), { text: 't' }),
    enrol: (p: any) => (calls.push(['enrol', p]), { enrolled: true }),
  };
  const { handlers, veils } = methodsOf({ codePair: codePair as any });
  assert.deepEqual(handlers['host.codePair.approvalText']({ offerId: ID }, 'cli', null, null, new Set()), { text: 't' });
  assert.deepEqual(handlers['host.codePair.enrol']({ key: 'k' }, 'cli'), { enrolled: true });
  assert.throws(() => handlers['host.codePair.enrol']({}, 'phone'), /does not pair by code/);
  assert.throws(() => handlers['host.codePair.approvalText']({}, 'controller', null, null, new Set()), /does not pair by code/);
  for (const m of ['approvalText', 'enrol']) {
    assert.equal(veils[`host.codePair.${m}`]({ kind: 'cli' }), true);
    assert.equal(veils[`host.codePair.${m}`]({ kind: 'phone' }), false);
  }
  assert.equal(calls.length, 2);
});
