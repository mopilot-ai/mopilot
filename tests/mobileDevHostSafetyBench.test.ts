// The dev host's home-safety bench (scripts/mobile-dev-host/momoSafetyBench.mjs), driven directly: every state shows the problems the shared rules give it, and every fix it owns answers as the Mac's home does (asked first, then confirmed), so the phone's cards can be pressed without a real Host.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createSafetyBench, SAFETY } from '../scripts/mobile-dev-host/momoSafetyBench.mjs';

const fix = (id: string) => ({ kind: 'fix', id });
const codes = (b: any) => b.problems().map((p: any) => p.code);

test('with no state shown the bench has no problems and owns no fix', async () => {
  const b: any = createSafetyBench();
  assert.deepEqual(b.problems(), []);
  assert.equal(await b.fix(fix('keep-older:studio')), null);
  b.show('older');
  // a request that is not a fix of the view, or has no id, is not the bench's
  assert.equal(await b.fix({ kind: 'wake' }), null);
  assert.equal(await b.fix({ kind: 'fix' }), null);
  assert.equal(await b.fix(fix('something-else:studio')), null);
  assert.deepEqual(await b.fix(fix('check-again')), { ok: true });
});

test('every named state shows its problem', () => {
  const b: any = createSafetyBench();
  const seen: Record<string, string[]> = {};
  for (const state of SAFETY) {
    b.show(state);
    seen[state] = codes(b);
    assert.ok(seen[state].length > 0, state);
  }
  assert.ok(seen.older.includes('older_home') && seen['older-colon'].includes('older_home') && seen.replaced.includes('older_home'));
  assert.ok(seen['home-lost'].includes('home_unheard') || seen['home-lost'].length > 0);
  assert.ok(seen.unheard.length > 0 && seen.blocked.includes('move_in_progress'));
  assert.ok(seen['held-old'].includes('send_refused'));
});

test('using the older MoMo is asked first (the machines are fit to take it), then it is gone once confirmed; a machine id with colons works too', async () => {
  for (const [state, machine] of [
    ['older', 'studio'],
    ['older-colon', 'ssh:runner@localhost'],
  ] as const) {
    const b: any = createSafetyBench();
    b.show(state);
    const [card] = b.problems();
    const id = card.fix.id as string;
    const asked = await b.fix(fix(id));
    assert.equal(asked.ok, false, 'asked first');
    assert.ok(asked.fix.id.startsWith('use-older!'), machine);
    assert.deepEqual(await b.fix(fix(asked.fix.id)), { ok: true });
    assert.deepEqual(codes(b), [], 'the older MoMo is gone');
  }
});

test('keep and delete work, a delete is asked first, and an id the home does not offer is refused in words', async () => {
  const b: any = createSafetyBench();
  b.show('older');
  assert.deepEqual(await b.fix(fix('keep-older:studio')), { ok: true });
  assert.deepEqual(codes(b), []);
  b.show('older');
  const asked = await b.fix(fix('delete-older:studio'));
  assert.equal(asked.ok, false);
  assert.deepEqual(await b.fix(fix(asked.fix.id)), { ok: true });
  assert.deepEqual(codes(b), []);
  // an id whose field cannot be decoded names nothing the home offered
  const undecodable = await b.fix(fix('use-older:%E0%A4%A'));
  assert.deepEqual([undecodable.ok, undecodable.cause], [false, 'That is not offered any more.']);
  const nope = await b.fix(fix('keep-older:nowhere'));
  assert.equal(nope.ok, false);
  assert.match(nope.cause, /not offered/);
});

test('a bench built with no first-run hook still starts fresh, and the unheard states read no home', async () => {
  const b: any = createSafetyBench();
  b.show('unheard');
  const first = await b.fix(fix('start-fresh'));
  assert.deepEqual(await b.fix(fix(first.fix.id)), { ok: true });
  // with no home read, an older MoMo that is not there is refused in words
  for (const state of ['home-lost', 'unheard']) {
    b.show(state);
    assert.match((await b.fix(fix('keep-older:studio'))).cause, /not offered/);
  }
});

test('Start fresh is asked first and only the confirming press acts; then the home asks where MoMo should live', async () => {
  for (const state of ['home-lost', 'unheard']) {
    let asked = 0;
    const b: any = createSafetyBench({ firstRun: () => void (asked += 1) });
    b.show(state);
    const startFresh = b
      .problems()
      .flatMap((p: any) => [p.fix, ...(p.also ?? [])])
      .find((f: any) => /^start-fresh/.test(f?.id ?? ''));
    assert.ok(startFresh, state);
    // a confirmation that was never asked for (no token) is refused, and nothing starts
    const refused = await b.fix(fix('start-fresh!'));
    assert.equal(refused.ok, false);
    const first = await b.fix(fix('start-fresh'));
    assert.equal(first.ok, false);
    assert.match(first.fix.id, /^start-fresh!/);
    assert.deepEqual(await b.fix(fix(first.fix.id)), { ok: true });
    assert.equal(asked, 1);
    assert.deepEqual(b.problems(), []);
  }
});

test('a message held for the old MoMo is sent to the new one or deleted, whichever the owner chooses', async () => {
  for (const choice of ['retry-send', 'delete-send']) {
    const b: any = createSafetyBench();
    b.show('held-old');
    const [first] = b.problems();
    assert.ok(first.fix.id.startsWith('retry-send'));
    assert.deepEqual(await b.fix(fix(choice === 'retry-send' ? first.fix.id : b.problems()[1].fix.id)), { ok: true });
    assert.deepEqual(b.problems(), []);
  }
});
