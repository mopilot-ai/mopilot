// Host tool relay schema validation and result formatting across the wire.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { fit } = require('../electron/host/toolRelay.cjs');
const S = require('../shared/host/schema.mjs');
const text = (t: string) => ({ type: 'text', text: t });

test('fit: text and images pass; another block or a bad image becomes words; nothing is silently dropped', () => {
  const image = { type: 'image', data: 'AAAA', mimeType: 'image/png' };
  assert.deepEqual(fit([{ type: 'text', text: 'a' }, image]), [{ type: 'text', text: 'a' }, image]);
  assert.deepEqual(fit([{ type: 'resource', uri: 'file:///x' }]), [{ type: 'text', text: '{"type":"resource","uri":"file:///x"}' }]);
  assert.deepEqual(fit([{ type: 'image', data: 'AAAA', mimeType: 'text/html' }]), [
    { type: 'text', text: '{"type":"image","data":"AAAA","mimeType":"text/html"}' },
  ]);
  assert.deepEqual(fit([undefined, 3]), [
    { type: 'text', text: '' },
    { type: 'text', text: '3' },
  ]);
  assert.deepEqual(fit(undefined), []);
  assert.deepEqual(fit('text'), []);
});

test('fit: a text over 1 MB is cut with a note, an image over 8 MB is told in words, more than 64 blocks end in one note, and what is left of the message is shared out', () => {
  const [cut] = fit([{ type: 'text', text: 'x'.repeat(2 * 1024 * 1024) }]);
  assert.equal(cut.text.length, 1024 * 1024);
  assert.match(cut.text, /\[cut: too long to pass on\]$/);
  assert.deepEqual(fit([{ type: 'image', data: 'A'.repeat(9 * 1024 * 1024), mimeType: 'image/png' }]), [
    { type: 'text', text: 'An image was too large to pass on.' },
  ]);
  const many = fit(Array.from({ length: 100 }, (_, i) => ({ type: 'text', text: String(i) })));
  assert.equal(many.length, 64);
  assert.deepEqual(many.at(-1), { type: 'text', text: '[37 more blocks were not passed on]' });
  // a message holds about 7 MB in all: two big images fit, the third is told in words
  const big = { type: 'image', data: 'A'.repeat(3 * 1024 * 1024), mimeType: 'image/png' };
  const shared = fit([big, big, big, { type: 'text', text: 'after' }]);
  assert.deepEqual(
    shared.map((b: any) => b.type),
    ['image', 'image', 'text', 'text'],
  );
  // no room at all: the rest is one note
  const full = fit([
    { type: 'image', data: 'A'.repeat(8 * 1024 * 1024 - 65 * 1024), mimeType: 'image/png' },
    { type: 'text', text: 'late' },
    { type: 'text', text: 'later' },
  ]);
  assert.equal(full.length, 2);
  assert.match(full[1].text, /more blocks were not passed on/);
});

test('fit: when the message has almost no room left, a text is cut to what is left and carries no note', () => {
  const image = { type: 'image', data: 'A'.repeat(8 * 1024 * 1024 - 65 * 1024 - 10), mimeType: 'image/png' };
  const [, text] = fit([image, { type: 'text', text: 'abcdefghijklmnopqrstuvwxyz' }]);
  assert.equal(text.text, 'abcdefghij');
});

test('B: tool lists and results are checked before they reach the Host', () => {
  assert.ok(S.FEATURES.includes('tools'));
  assert.deepEqual(S.REQUIRES['host.toolsSync'], ['tools']);
  assert.deepEqual(S.REQUIRES['host.toolResult'], ['tools']);
  const sync = (tools: unknown) => S.parseParams('host.toolsSync', { tools });
  assert.deepEqual(sync([]), { tools: [] });
  assert.deepEqual(sync([{ name: 'browser_open', policy: 'act', extra: 1 }]).tools[0], {
    name: 'browser_open',
    description: '',
    inputSchema: { type: 'object', properties: {} },
    policy: 'act',
  });
  const bad = (fn: () => unknown) => assert.throws(fn, (e: any) => e instanceof S.SchemaError);
  bad(() => S.parseParams('host.toolsSync', {}));
  bad(() => sync(Array.from({ length: 257 }, (_, i) => ({ name: `t${i}`, policy: 'act' }))));
  bad(() => sync(['x']));
  bad(() => sync([{ name: 'a b', policy: 'act' }]));
  bad(() => sync([{ name: 'a', policy: 'maybe' }]));
  bad(() =>
    sync([
      { name: 'a', policy: 'act' },
      { name: 'a', policy: 'act' },
    ]),
  );
  bad(() => sync([{ name: 'a', policy: 'act', description: 3 }]));
  bad(() => sync([{ name: 'a', policy: 'act', description: 'x'.repeat(9000) }]));
  bad(() => sync([{ name: 'a', policy: 'act', inputSchema: 'x' }]));
  bad(() => sync([{ name: 'a', policy: 'act', inputSchema: { big: 'x'.repeat(70000) } }]));

  const result = (r: object) => S.parseParams('host.toolResult', { chatId: 'acp:fake:a', epoch: 3, callId: 'c1', ...r });
  assert.deepEqual(
    result({ ok: true, content: [text('hi'), { type: 'image', data: 'AAAA', mimeType: 'image/png', extra: 1 }], endsTurn: true }),
    {
      chatId: 'acp:fake:a',
      epoch: 3,
      callId: 'c1',
      ok: true,
      content: [text('hi'), { type: 'image', data: 'AAAA', mimeType: 'image/png' }],
      endsTurn: true,
    },
  );
  assert.equal(result({ ok: true, content: [] }).endsTurn, undefined);
  assert.deepEqual(result({ ok: false, content: [], error: { code: 'denied', message: 'No.' }, endsTurn: true }).error, {
    code: 'denied',
    message: 'No.',
  });
  bad(() => S.parseParams('host.toolResult', { callId: 'c1', epoch: 3, ok: true, content: [] }));
  bad(() => S.parseParams('host.toolResult', { chatId: 'acp:fake:a', callId: 'c1', ok: true, content: [] }));
  bad(() => result({ callId: 'a b', ok: true, content: [] }));
  bad(() => result({ ok: 'yes', content: [] }));
  bad(() => result({ ok: true }));
  bad(() => result({ ok: true, content: Array.from({ length: 65 }, () => text('x')) }));
  bad(() => result({ ok: true, content: [{ type: 'video' }] }));
  // one result is at most a frame: a 2 MB screenshot passes, a result over the frame does not
  assert.equal(result({ ok: true, content: [{ type: 'image', data: 'A'.repeat(2 * 1024 * 1024), mimeType: 'image/png' }] }).ok, true);
  bad(() => result({ ok: true, content: [{ type: 'text', text: 'x'.repeat(8 * 1024 * 1024) }] }));
  bad(() =>
    result({
      ok: true,
      content: [
        { type: 'text', text: 'x'.repeat(5 * 1024 * 1024) },
        { type: 'image', data: 'A'.repeat(4 * 1024 * 1024), mimeType: 'image/png' },
      ],
    }),
  );
  bad(() => result({ ok: true, content: [{ type: 'image', data: 'AA', mimeType: 'text/html' }] }));
  bad(() => result({ ok: false, content: [] }));
  bad(() => result({ ok: false, content: [], error: { code: '', message: 'x' } }));
  bad(() => result({ ok: false, content: [], error: { code: 'x', message: 3 } }));
});
