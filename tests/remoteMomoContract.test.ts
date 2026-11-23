// The Mac and the phone agree on momo.*: every reply the desktop's real handlers give (electron/remote/methods/momo.cjs over MoMo's real stores) goes through the phone's own parsers (mobile/src/momo/contract.ts), the hello flags the phone reads are pinned, and every method the phone calls exists in the Mac's schema.
import './support/tz-la.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { sweep } from './support/momo-routines.ts';
import { ok, fail, askSlow, momoRig, SAMPLE } from './support/remote-momo-kit.ts';
import { momoAllowed, parseBrain, parseDocs, parseFacts, parseRoutines, changedTopic } from '../mobile/src/momo/contract';

const require = createRequire(import.meta.url);
const { PARSERS } = require('../shared/remote/schema.mjs');

test('hello: the phone reads capabilities.momo, and capabilities.momoBrainSet follows the Mac setting (false for an uninvited account)', async () => {
  const m = momoRig({ remoteBrain: false });
  const p = m.r.phone('p1');
  const off = ok(await p.ask('machine.hello'));
  assert.equal(momoAllowed(off), true);
  assert.equal(off.capabilities.momoBrainSet, false);
  m.gate.remoteBrain = true;
  assert.equal(ok(await p.ask('machine.hello')).capabilities.momoBrainSet, true);
  const uninvited = momoRig({ allowed: false, remoteBrain: true });
  uninvited.r.service.momoAllowed = () => false;
  const hello = ok(await uninvited.r.phone('p1').ask('machine.hello'));
  assert.deepEqual([momoAllowed(hello), hello.capabilities.momoBrainSet], [false, undefined]);
  assert.ok(!('momo' in hello.capabilities) && !('momoBrainSet' in hello.capabilities));
});

test('memory, docs, routines, brain and the change event, as the Mac sends them, parse on the phone', async () => {
  const m = momoRig({ harness: 'claude' });
  const p = m.r.phone('p1');
  const soon = Date.now() + 60_000;
  await m.store.save({ text: 'Likes green tea', source: 'user', confidence: 'sure' });
  await m.store.save({ text: 'Trip to Lyon', source: 'user', confidence: 'sure', expiresAt: soon });
  await m.store.writeFile('aboutYou', 'I am Sam');
  const facts = parseFacts(ok(await askSlow(p, 'momo.memory.list')));
  assert.deepEqual(facts.map((f) => [f.text, f.expired]).sort(), [
    ['Likes green tea', false],
    ['Trip to Lyon', false],
  ]);
  assert.deepEqual(
    parseFacts(ok(await askSlow(p, 'momo.memory.search', { query: 'lyon' }))).map((f) => f.text),
    ['Trip to Lyon'],
  );
  const docs = parseDocs(ok(await askSlow(p, 'momo.memory.docs')));
  assert.deepEqual([docs.aboutYou, docs.persona, docs.unreadable], ['I am Sam', '', []]);
  // routines: a proposal with its version, an approved routine, one a phone paused
  const a = await m.w.routines.add({ ...sweep, name: 'Sweep' }, { approved: true });
  await m.w.routines.add({ ...sweep, name: 'Proposed' }, { approved: false });
  await askSlow(p, 'momo.routines.pause', { id: a.id });
  const routines = parseRoutines(ok(await askSlow(p, 'momo.routines.list')));
  assert.deepEqual(
    routines.routines.map((r) => [r.name, r.paused]),
    [['Sweep', true]],
  );
  assert.deepEqual(
    routines.proposals.map((x) => [x.name, x.rev]),
    [['Proposed', 1]],
  );
  assert.equal(parseBrain(ok(await askSlow(p, 'momo.brain.get'))), null, 'a brain with no model name shows no chip');
  m.mainChat.getBrain = () => ({ harness: 'claude', account: null, model: 'opus', modelLabel: 'Opus' }) as any;
  assert.deepEqual(parseBrain(ok(await askSlow(p, 'momo.brain.get'))), { label: 'Opus' });
  // the change event the phone re-reads on
  m.r.service.onMomoChanged('routines');
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(
    p
      .events('momo.changed')
      .map(changedTopic)
      .filter((t) => t === 'routines').length > 0,
    true,
  );
});

test('errors the phone shows are the Mac’s words; a refusal needs no code branch', async () => {
  const m = momoRig();
  const p = m.r.phone('p1');
  fail(await askSlow(p, 'momo.brain.set', { brain: { harness: 'codex' } }), 'forbidden', /Allow brain changes from this Mac first/);
  fail(await askSlow(p, 'momo.memory.forget', { factId: 'nope' }), 'failed', /no longer in memory/);
  fail(await askSlow(p, 'momo.routines.run', { id: 'nope' }), 'gone', /isn't one of MoMo's routines/);
});

test('every momo.* method the phone calls is one the Mac has, and none names a chat', () => {
  const api =
    fs.readFileSync(path.join('mobile', 'src', 'momo', 'api.ts'), 'utf8') +
    fs.readFileSync(path.join('mobile', 'src', 'momo', 'follow.ts'), 'utf8');
  const called = [...new Set([...api.matchAll(/['"`](momo\.[a-z.]+)['"`]/g)].map((x) => x[1]))];
  assert.ok(called.length >= 10, `found ${called.join(', ')}`);
  for (const method of called) assert.ok(Object.hasOwn(PARSERS, method), `the phone calls ${method}, which the Mac does not have`);
  for (const method of Object.keys(PARSERS).filter((x) => x.startsWith('momo.')))
    assert.equal(PARSERS[method]({ ...SAMPLE[method], chatId: 'x' }).chatId, undefined, method);
});
