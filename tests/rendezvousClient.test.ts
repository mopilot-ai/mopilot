// The Host's calls to the relay's rendezvous (host/src/rendezvousClient.mjs, R2b of #5576): where each goes, what it carries (the account token on the offer only), what a refusal, a silent failure and a relay that is not there are, and that a redirect is never followed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
// @ts-ignore: plain ESM without declarations
import { createRendezvousClient, MAX_BODY, MAX_MESSAGES, MAX_OFFER_MS } from '../host/src/rendezvousClient.mjs';

const ID = `r_${'A'.repeat(22)}`;
const BASE = 'https://relay.example';

/** A response body that arrives in pieces, as a reader. @param {string[]} chunks */
const streamOf = (chunks: string[], cancelled?: { n: number }) => ({
  getReader: () => {
    let i = 0;
    return {
      read: async () =>
        i < chunks.length ? { done: false, value: new TextEncoder().encode(chunks[i++]) } : { done: true, value: undefined },
      cancel: async () => void (cancelled && cancelled.n++),
    };
  },
});

/** A fetch that answers from a script and records what it was asked. */
function scripted(...answers: any[]) {
  const asked: any[] = [];
  const doFetch = async (url: URL, init: any) => {
    asked.push({ url: String(url), init });
    const a = answers.shift();
    if (a instanceof Error) throw a;
    return {
      status: a.status,
      headers: a.headers ? { get: (k: string) => a.headers[k] } : undefined,
      body: a.chunks ? streamOf(a.chunks, a.cancelled) : undefined,
      text: async () => (a.text !== undefined ? a.text : JSON.stringify(a.json ?? null)),
    };
  };
  return { asked, client: createRendezvousClient({ fetch: doFetch as any, timeoutMs: 1000 }) as any };
}

test("an offer sends the account token and nothing else, and answers the relay's id, hint, ticket and time", async () => {
  const s = scripted({ status: 200, json: { id: ID, hint: 'K7Q', ticket: 'T'.repeat(22), expiresAt: 5 } });
  assert.deepEqual(await s.client.offer({ base: BASE, token: 'secret-token' }), {
    ok: true,
    id: ID,
    hint: 'K7Q',
    ticket: 'T'.repeat(22),
    expiresAt: 5,
  });
  assert.equal(s.asked[0].url, `${BASE}/v1/rendezvous/offer`);
  assert.equal(s.asked[0].init.headers.authorization, 'Bearer secret-token');
  assert.equal(s.asked[0].init.body, '{}');
  assert.equal(s.asked[0].init.redirect, 'error');
});

test("read, send and close go to the offer's own paths with its ticket, and carry no token", async () => {
  const s = scripted(
    { status: 200, json: { claims: 2, expiresAt: 9, messages: [{ n: 1, box: 'b' }] } },
    { status: 200, json: { n: 3 } },
    { status: 204 },
    { status: 200, json: { claims: 0, expiresAt: 1, messages: [] } },
  );
  assert.deepEqual(await s.client.read({ base: BASE, id: ID, ticket: 'T', after: 4 }), {
    ok: true,
    claims: 2,
    expiresAt: 9,
    messages: [{ n: 1, box: 'b' }],
  });
  assert.deepEqual(await s.client.send({ base: BASE, id: ID, ticket: 'T', claims: 2, box: 'abc' }), { ok: true });
  assert.deepEqual(await s.client.close({ base: BASE, id: ID, ticket: 'T' }), { ok: true });
  assert.deepEqual((await s.client.read({ base: BASE, id: ID, ticket: 'T', after: 0 })).messages, []);
  assert.deepEqual(
    s.asked.map((a) => a.url),
    [
      `${BASE}/v1/rendezvous/${ID}/read`,
      `${BASE}/v1/rendezvous/${ID}/send`,
      `${BASE}/v1/rendezvous/${ID}/close`,
      `${BASE}/v1/rendezvous/${ID}/read`,
    ],
  );
  assert.deepEqual(JSON.parse(s.asked[1].init.body), { ticket: 'T', claims: 2, box: 'abc' });
  assert.ok(s.asked.every((a) => a.init.headers.authorization === undefined));
});

test("a refusal is its reason: the relay's own word, else the kind of status; a relay that is down, silent or not JSON is never an exception", async () => {
  const s: any = scripted(
    { status: 429, json: { error: 'account_limit' } },
    { status: 401, text: '' },
    { status: 403, json: null },
    { status: 404, json: null },
    { status: 429, json: null },
    { status: 502, text: '<html>' },
    { status: 200, text: 'not json' },
    new Error('connect ECONNREFUSED'),
    { status: 409, json: { error: 'wait' } },
  );
  const reasons: any[] = [];
  reasons.push((await s.client.offer({ base: BASE, token: 't' })).reason);
  reasons.push((await s.client.offer({ base: BASE, token: 't' })).reason);
  reasons.push((await s.client.offer({ base: BASE, token: 't' })).reason);
  reasons.push((await s.client.read({ base: BASE, id: ID, ticket: 'T', after: 0 })).reason);
  reasons.push((await s.client.read({ base: BASE, id: ID, ticket: 'T', after: 0 })).reason);
  reasons.push((await s.client.close({ base: BASE, id: ID, ticket: 'T' })).reason);
  assert.deepEqual(reasons, ['account_limit', 'unauthorized', 'unauthorized', 'gone', 'limited', 'relay']);
  // a good status with a body that is not what a read answers is no read
  assert.deepEqual(await s.client.read({ base: BASE, id: ID, ticket: 'T', after: 0 }), { ok: false, reason: 'relay' });

  assert.deepEqual(await s.client.send({ base: BASE, id: ID, ticket: 'T', claims: 1, box: 'x' }), { ok: false, reason: 'unreachable' });
  assert.deepEqual(await s.client.send({ base: BASE, id: ID, ticket: 'T', claims: 1, box: 'x' }), { ok: false, reason: 'wait' });
});

test('by default it uses the platform fetch', () => {
  assert.equal(typeof createRendezvousClient().offer, 'function');
});

test("an offer is only what the relay's own shapes allow, and its end is never further than an offer lasts", async () => {
  const good = { id: ID, hint: 'K7Q', ticket: 'T'.repeat(22), expiresAt: 5 };
  const bads = [
    { ...good, id: 'x' },
    { ...good, hint: 'k7q' },
    { ...good, hint: 'K0Q' },
    { ...good, ticket: 'short' },
    { ...good, expiresAt: 'soon' },
    { ...good, expiresAt: Number.NaN },
    null,
    'text',
  ];
  const s = scripted(...bads.map((json) => ({ status: 200, json })), {
    status: 200,
    json: { ...good, expiresAt: Date.now() + 99 * 3600_000 },
  });
  for (const _ of bads) assert.deepEqual(await s.client.offer({ base: BASE, token: 't' }), { ok: false, reason: 'relay' });
  const far = await s.client.offer({ base: BASE, token: 't' });
  assert.ok(far.ok && far.expiresAt <= Date.now() + MAX_OFFER_MS, 'capped');
});

test('a read is typed and bounded: claims 0 to 5, at most six messages of base64url that the relay numbered, and an end that is a number', async () => {
  const ok = { claims: 1, expiresAt: 9, messages: [{ n: 1, box: 'abc_-' }] };
  const bads = [
    { ...ok, claims: 6 },
    { ...ok, claims: -1 },
    { ...ok, claims: '1' },
    { ...ok, expiresAt: 'x' },
    { ...ok, messages: 'none' },
    { ...ok, messages: Array.from({ length: MAX_MESSAGES + 1 }, (_, i) => ({ n: i + 1, box: 'a' })) },
    { ...ok, messages: [{ n: 0, box: 'a' }] },
    { ...ok, messages: [{ n: 1.5, box: 'a' }] },
    { ...ok, messages: [{ n: 1, box: 5 }] },
    { ...ok, messages: [{ n: 1, box: 'has space' }] },
    { ...ok, messages: [{ n: 1, box: 'a'.repeat(2801) }] },
    { ...ok, messages: [null] },
    null,
  ];
  const s = scripted(...bads.map((json) => ({ status: 200, json })), { status: 200, json: ok });
  for (const _ of bads)
    assert.deepEqual(await s.client.read({ base: BASE, id: ID, ticket: 'T', after: 0 }), { ok: false, reason: 'relay' });
  assert.deepEqual(await s.client.read({ base: BASE, id: ID, ticket: 'T', after: 0 }), { ok: true, ...ok });
});

test('an answer bigger than the bound is not read on: by the length the relay says, or by the text that came', async () => {
  const s = scripted(
    { status: 200, headers: { 'content-length': String(MAX_BODY + 1) }, json: {} },
    { status: 200, text: 'x'.repeat(MAX_BODY + 1) },
    { status: 200, headers: { 'content-length': '12' }, json: { claims: 0, expiresAt: 1, messages: [] } },
  );
  assert.deepEqual(await s.client.read({ base: BASE, id: ID, ticket: 'T', after: 0 }), { ok: false, reason: 'relay' });
  assert.deepEqual(await s.client.read({ base: BASE, id: ID, ticket: 'T', after: 0 }), { ok: false, reason: 'relay' });
  assert.equal((await s.client.read({ base: BASE, id: ID, ticket: 'T', after: 0 })).ok, true);
});

test("a relay's own word is a reason only when it is a short lower-case word; anything else is the kind of status", async () => {
  const s = scripted(
    { status: 429, json: { error: '<script>alert(1)</script>' } },
    { status: 429, json: { error: 'Limited' } },
    { status: 404, json: { error: 'x'.repeat(33) } },
    { status: 409, json: { error: 'wait' } },
    { status: 500, json: { error: 7 } },
  );
  const out: any[] = [];
  for (let i = 0; i < 5; i++) out.push((await s.client.close({ base: BASE, id: ID, ticket: 'T' })).reason);
  assert.deepEqual(out, ['limited', 'limited', 'gone', 'wait', 'relay']);
});

test('an answer is read in pieces and given up on the moment it passes the bound, and one that arrives whole in pieces is read', async () => {
  const cancelled = { n: 0 };
  const big = scripted({
    status: 200,
    chunks: ['{"claims":0,"expiresAt":1,"messages":[],"pad":"', 'x'.repeat(MAX_BODY), 'x'.repeat(MAX_BODY), '"}'],
    cancelled,
  });
  assert.deepEqual(await big.client.read({ base: BASE, id: ID, ticket: 'T', after: 0 }), { ok: false, reason: 'relay' });
  assert.equal(cancelled.n, 1, 'the relay was cut off, not waited for');
  const pieces = scripted({ status: 200, chunks: ['{"claims":1,"expi', 'resAt":9,"mess', 'ages":[{"n":1,"box":"ab"}]}'] });
  assert.deepEqual(await pieces.client.read({ base: BASE, id: ID, ticket: 'T', after: 0 }), {
    ok: true,
    claims: 1,
    expiresAt: 9,
    messages: [{ n: 1, box: 'ab' }],
  });
});
