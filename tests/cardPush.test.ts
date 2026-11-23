// The sealed approval-push blob (shared/remote/cardPush.mjs): detail levels, binding to ref, request and revision, the size cap, and the relay never seeing command text.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createNodePrimitives } from '../shared/remote/nodePrimitives.mjs';
import { createCardPush, cardText, toolPhrase, opensApp, MAX_CARD_BLOB_BYTES } from '../shared/remote/cardPush.mjs';

const prim = createNodePrimitives();
const cp = createCardPush(prim);
const root = new Uint8Array(32).fill(7);
const key = cp.cardKey(root);
const card = {
  machine: 'build-box',
  tool: 'execute',
  line: 'git push origin fix/login-retry',
  stat: '2 files +10 -3',
};
const base = { key, ref: 'ref1', requestId: 'req-1', rev: 3, card };

test('a card key is stable, 32 bytes, and differs by root', () => {
  assert.equal(key.length, 32);
  assert.deepEqual(key, cp.cardKey(root));
  assert.notDeepEqual(key, cp.cardKey(new Uint8Array(32).fill(8)));
});

test('tool detail carries machine and kind but not the summary line', () => {
  const sealed = cp.seal({ ...base, detail: 'tool' })!;
  const opened = cp.open({ sealed, ref: 'ref1', keys: [key] })!;
  assert.equal(opened.requestId, 'req-1');
  assert.equal(opened.rev, 3);
  assert.deepEqual(opened.card, { machine: 'build-box', tool: 'execute' });
  assert.deepEqual(cardText(opened.card), {
    title: 'build-box · run a command',
    body: '',
  });
});

test('full detail adds the line and stat; a question card says so', () => {
  const sealed = cp.seal({
    ...base,
    detail: 'full',
    card: { ...card, tool: 'question', question: true },
  })!;
  const opened = cp.open({ sealed, ref: 'ref1', keys: [key] })!;
  assert.deepEqual(cardText(opened.card), {
    title: 'build-box · ask a question',
    body: 'git push origin fix/login-retry · 2 files +10 -3',
  });
});

test('minimal detail shows fixed text but still carries the ids the action needs', () => {
  const sealed = cp.seal({ ...base, detail: 'minimal' })!;
  const opened = cp.open({ sealed, ref: 'ref1', keys: [key] })!;
  assert.deepEqual(opened.card, {});
  assert.equal(opened.requestId, 'req-1');
  assert.deepEqual(cardText(opened.card), {
    title: 'A chat needs you',
    body: '',
  });
});

test('the relay sees no command text, machine name or summary in a blob', () => {
  const planted = 'rm -rf /secret-plan-7731';
  for (const detail of ['minimal', 'tool', 'full']) {
    const sealed = cp.seal({
      ...base,
      detail,
      card: { ...card, line: planted, machine: 'mach-7731' },
    })!;
    const raw = Buffer.from(sealed, 'base64url').toString('latin1');
    assert.ok(!sealed.includes('7731') && !raw.includes('7731') && !raw.includes('rm -rf'));
    assert.match(sealed, /^[A-Za-z0-9_-]+$/);
  }
});

test('a blob does not open under another ref, request, revision, key or version', () => {
  const sealed = cp.seal({ ...base, detail: 'full' })!;
  assert.equal(cp.open({ sealed, ref: 'other', keys: [key] }), null);
  assert.equal(
    cp.open({
      sealed,
      ref: 'ref1',
      keys: [cp.cardKey(new Uint8Array(32).fill(9))],
    }),
    null,
  );
  const bytes = Buffer.from(sealed, 'base64url');
  const tamper = (fn: (b: Buffer) => void) => {
    const copy = Buffer.from(bytes);
    fn(copy);
    return copy.toString('base64url');
  };
  assert.equal(cp.open({ sealed: tamper((b) => (b[0] = 2)), ref: 'ref1', keys: [key] }), null);
  assert.equal(
    cp.open({
      sealed: tamper((b) => (b[2 + 5 - 1] ^= 1)),
      ref: 'ref1',
      keys: [key],
    }),
    null,
  );
  assert.equal(
    cp.open({
      sealed: tamper((b) => (b[2 + 5 + 3] ^= 1)),
      ref: 'ref1',
      keys: [key],
    }),
    null,
  );
});

test('several keys: the tag picks the right one; short keys are skipped', () => {
  const sealed = cp.seal({ ...base, detail: 'tool' })!;
  const other = cp.cardKey(new Uint8Array(32).fill(1));
  assert.ok(cp.open({ sealed, ref: 'ref1', keys: [new Uint8Array(3), other, key] }));
  assert.equal(cp.open({ sealed, ref: 'ref1', keys: [] }), null);
});

test('garbage never opens', () => {
  for (const s of [
    '',
    '!!!',
    'AA',
    'AQAA',
    Buffer.from([1, 0, 1, 2, 3]).toString('base64url'),
    Buffer.alloc(MAX_CARD_BLOB_BYTES + 5, 1).toString('base64url'),
  ])
    assert.equal(cp.open({ sealed: s, ref: 'ref1', keys: [key] }), null);
  // a request id that is not UTF-8
  const bad = Buffer.concat([Buffer.from([1, 2, 0xff, 0xfe, 0, 0, 0, 1]), Buffer.alloc(24 + 17)]);
  assert.equal(cp.open({ sealed: bad.toString('base64url'), ref: 'ref1', keys: [key] }), null);
});

test('a plaintext that is not an object, or an opener that throws, is skipped', () => {
  const sealWith = (plain: string) => {
    const real = createNodePrimitives();
    const p = { ...real, aeadOpen: real.aeadOpen };
    const rid = Buffer.from('r');
    const nonce = new Uint8Array(24).fill(2);
    const box = real.aeadSeal(key, nonce, new TextEncoder().encode(plain), new TextEncoder().encode('mopilot-push-card-v1|ref1|r|0'));
    const out = Buffer.concat([Buffer.from([1, 1]), rid, Buffer.from([0, 0, 0, 0]), Buffer.from(nonce), Buffer.from(box)]);
    return { p, sealed: out.toString('base64url') };
  };
  for (const plain of ['[]', 'null', 'nope', '"x"']) {
    const { sealed } = sealWith(plain);
    assert.equal(cp.open({ sealed, ref: 'ref1', keys: [key] }), null);
  }
  const { sealed } = sealWith('{"machine":"m","tool":"zzz","question":true,"line":"l","stat":"s"}');
  assert.deepEqual(cp.open({ sealed, ref: 'ref1', keys: [key] })!.card, {
    machine: 'm',
    question: true,
    line: 'l',
    stat: 's',
  });
  const throwing = createCardPush({
    ...prim,
    aeadOpen: () => {
      throw new Error('x');
    },
  });
  assert.equal(throwing.open({ sealed, ref: 'ref1', keys: [key] }), null);
});

test('the worst case stays within the cap, and long text is truncated', () => {
  const wide = '\u4e00'.repeat(500);
  const sealed = cp.seal({
    ...base,
    requestId: 'r'.repeat(255),
    detail: 'full',
    card: { machine: wide, tool: 'edit', line: wide, stat: wide },
  })!;
  assert.ok(Buffer.from(sealed, 'base64url').length <= MAX_CARD_BLOB_BYTES);
  assert.ok(sealed.length <= 2048);
  const opened = cp.open({ sealed, ref: 'ref1', keys: [key] })!;
  assert.deepEqual([opened.card.machine!.length, opened.card.line!.length, opened.card.stat!.length], [64, 160, 40]);
});

test('ids that cannot be carried, and control characters, are handled', () => {
  assert.equal(cp.seal({ ...base, requestId: '', detail: 'tool' }), null);
  assert.equal(cp.seal({ ...base, requestId: 'r'.repeat(256), detail: 'tool' }), null);
  assert.equal(cp.seal({ ...base, rev: -1, detail: 'tool' }), null);
  assert.equal(cp.seal({ ...base, rev: 2 ** 32, detail: 'tool' }), null);
  const sealed = cp.seal({
    ...base,
    detail: 'full',
    card: {
      machine: 'a\nb',
      tool: 'weird',
      line: 5 as unknown as string,
      stat: '',
    },
  })!;
  assert.deepEqual(cp.open({ sealed, ref: 'ref1', keys: [key] })!.card, {
    machine: 'a b',
    tool: 'other',
  });
});

test('tool phrases and which kinds open the app', () => {
  assert.equal(toolPhrase('delete'), 'delete files');
  assert.equal(toolPhrase('nonsense'), 'do something');
  assert.ok(opensApp('delete') && opensApp('fetch') && !opensApp('execute'));
  assert.deepEqual(cardText({ tool: 'edit' }), {
    title: 'edit files',
    body: '',
  });
});

test('a reminder, a pause and a clearing carry their state at every detail level', () => {
  for (const detail of ['minimal', 'tool', 'full']) {
    const get = (state: string) => {
      const sealed = cp.seal({ ...base, detail, state })!;
      return cp.open({ sealed, ref: 'ref1', keys: [key] })!.card;
    };
    assert.equal(get('reminder').state, 'reminder');
    assert.equal(get('paused').state, 'paused');
    assert.equal(get('cleared').state, 'cleared');
    assert.equal(get('waiting').state, undefined);
    assert.equal(get('bogus').state, undefined);
  }
  assert.deepEqual(cardText({ state: 'reminder' }), {
    title: 'Still waiting for you',
    body: '',
  });
  assert.deepEqual(cardText({ state: 'reminder', machine: 'b' }), {
    title: 'b · still waiting',
    body: '',
  });
  assert.deepEqual(cardText({ state: 'paused' }).title, 'A chat paused');
  assert.deepEqual(cardText({ state: 'paused', machine: 'b' }).title, 'b · paused');
  assert.deepEqual(cardText({ state: 'cleared' }), {
    title: 'A chat no longer needs you',
    body: '',
  });
});
