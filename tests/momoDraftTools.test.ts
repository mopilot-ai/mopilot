// MoMo's draft tool (electron/momo/draftTools.cjs): momo_draft puts a draft in the chat's own history as a note and tells the model plainly that nothing was sent; only a MoMo chat that is not a background pass sees it while MoMo is allowed, a bad draft is refused with why, a chat that is gone says so, and a chat keeps its newest drafts only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { registerDraftTools, MAX_DRAFTS } = require('../electron/momo/draftTools.cjs');
const { Registry } = require('../electron/capabilities/contract/registry.cjs');

function rig(o: { owner?: (ctx: any) => string | null; patch?: boolean } = {}) {
  const records = new Map<string, any>([
    ['momo-main', { meta: { momo: 'main', notes: [{ id: 'other', kind: 'nudge' }] } }],
    ['momo-pass', { meta: {} }],
    ['coding-1', { meta: {} }],
  ]);
  const told: any[] = [];
  const gate = {
    allowed: true,
    momo: new Set(['momo-main', 'momo-pass']),
    pass: new Set(['momo-pass']),
    turn: 'ct-1' as string | null,
    patch: o.patch ?? true,
  };
  const chats = {
    record: (id: string) => records.get(id),
    patchMeta: (id: string, patch: any) => {
      if (!gate.patch) return false;
      Object.assign(records.get(id).meta, patch);
      return true;
    },
    get: (id: string) => ({ id, meta: records.get(id)?.meta }),
  };
  const registry = new Registry();
  registry.setApprover(async () => true);
  let at = 1_000;
  const off = registerDraftTools(registry, {
    chats,
    turnOf: () => gate.turn,
    changed: (id: string, chat: any) => void told.push([id, chat]),
    allowed: () => gate.allowed,
    isMomoChat: (id: string) => gate.momo.has(id),
    owner: o.owner ?? ((ctx: any) => ctx.chatId),
    passChat: (id: string) => gate.pass.has(id),
    now: () => at++,
  });
  const call = (args: any, chatId = 'momo-main') => registry.invoke(chatId, 'claude:s1', 'momo_draft', args);
  const text = (r: any) => r.content.map((c: any) => c.text).join('');
  return { records, told, gate, registry, off, call, text };
}

test('the tool is listed only for MoMo’s own chats while MoMo is allowed; a call from elsewhere is refused', async () => {
  const t = rig();
  const names = (chatId: string) => t.registry.list({ chatId }).map((x: any) => x.name);
  assert.deepEqual(names('momo-main'), ['momo_draft']);
  assert.deepEqual(names('coding-1'), []);
  assert.deepEqual(names('momo-pass'), [], 'a data-only pass chat never sees it');
  t.gate.allowed = false;
  assert.deepEqual(names('momo-main'), []);
  t.gate.allowed = true;
  for (const chat of ['coding-1', 'momo-pass']) assert.equal((await t.call({ body: 'x' }, chat)).error.code, 'unavailable');
  assert.equal((await rig({ owner: () => null }).call({ body: 'x' })).error.code, 'unavailable');
  t.off();
  assert.deepEqual(names('momo-main'), []);
});

test('a draft is a note in the chat’s own history after the turn that wrote it, and the model is told nothing was sent', async () => {
  const t = rig();
  const r = await t.call({ to: ['Sam@Example.com'], subject: 'Re: lunch', body: 'Friday works.' });
  assert.equal(r.error, undefined);
  const said = t.text(r);
  assert.match(said, /Showed the user the draft for Sam@Example\.com as a card with Edit, Copy and Open in Mail/);
  assert.match(said, /Nothing was sent, and MoMo has no way to send it/);
  const notes = t.records.get('momo-main').meta.notes;
  assert.deepEqual(notes[0], { id: 'other', kind: 'nudge' }, 'other notes are kept');
  assert.deepEqual(notes[1], {
    id: 'draft-1000-1',
    kind: 'draft',
    text: 'Draft · Re: lunch',
    turnId: 'ct-1',
    turn: Number.MAX_SAFE_INTEGER,
    at: 1000,
    draft: { to: ['Sam@Example.com'], subject: 'Re: lunch', body: 'Friday works.' },
  });
  assert.deepEqual(
    t.told.map(([id]) => id),
    ['momo-main'],
    'windows are told the chat changed',
  );
  // no recipient, and a turn that is not known
  t.gate.turn = null;
  const none = await t.call({ body: 'Hello' });
  assert.match(t.text(none), /with no recipient/);
  assert.equal(t.records.get('momo-main').meta.notes.at(-1).turnId, null);
});

test('a draft that is not one is refused with why and nothing is shown', async () => {
  const t = rig();
  const r = await t.call({ to: ['nope'], body: 'x' });
  assert.equal(r.error.code, 'bad_to');
  assert.match(r.error.message, /not an email address/);
  assert.equal((await t.call({ body: '' })).error.code, 'bad_body');
  assert.equal((await t.call({ body: 'x'.repeat(7000) })).error.code, 'too_long');
  assert.equal(t.records.get('momo-main').meta.notes.length, 1);
  assert.equal(t.told.length, 0);
});

test('a chat that is gone, or a store that will not take the note, says so', async () => {
  const t = rig({ patch: false });
  const r = await t.call({ body: 'x' });
  assert.equal(r.error.code, 'unavailable');
  assert.match(r.error.message, /draft was not shown/);
  assert.equal(t.told.length, 0);
  const gone = rig();
  gone.records.delete('momo-main');
  assert.equal((await gone.call({ body: 'x' })).error.code, 'unavailable');
});

test('a chat keeps its newest drafts: past the most, the oldest go and other notes stay', async () => {
  const t = rig();
  for (let i = 0; i < MAX_DRAFTS + 3; i++) await t.call({ subject: `n${i}`, body: 'x' });
  const notes = t.records.get('momo-main').meta.notes;
  const drafts = notes.filter((n: any) => n.kind === 'draft');
  assert.equal(drafts.length, MAX_DRAFTS);
  assert.equal(drafts[0].draft.subject, 'n3');
  assert.equal(drafts.at(-1).draft.subject, `n${MAX_DRAFTS + 2}`);
  assert.equal(notes[0].id, 'other');
});

test('a chat with no notes yet gets its first one', async () => {
  const t = rig();
  delete t.records.get('momo-main').meta.notes;
  assert.equal((await t.call({ body: 'x' })).error, undefined);
  assert.equal(t.records.get('momo-main').meta.notes.length, 1);
});

test('without an owner, its chat gate or a registry listing it, the defaults refuse', async () => {
  const registry = new Registry();
  registry.setApprover(async () => true);
  registerDraftTools(registry, {
    chats: { record: () => undefined, patchMeta: () => false, get: () => undefined },
    turnOf: () => null,
    changed: () => undefined,
    allowed: () => true,
    isMomoChat: () => true,
  });
  assert.deepEqual(
    registry.list({ chatId: 'momo-main' }).map((x: any) => x.name),
    ['momo_draft'],
  );
  assert.equal((await registry.invoke('momo-main', 'claude:s1', 'momo_draft', { body: 'x' })).error.code, 'unavailable');
});
