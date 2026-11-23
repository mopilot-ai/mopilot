// What a person reads for each refusal MoMo's home, turns and move raise (shared/host/refusalWords.mjs): the real cause in one line, with the action it offers, and nothing a machine chat's send queue would say.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
// @ts-ignore: plain ESM without declarations
import { refusalWords, REFUSAL_CODES, REFUSAL_ACTIONS } from '../shared/host/refusalWords.mjs';

const ROOT = path.join(import.meta.dirname, '..');
/** Every code the MoMo files of the Host raise, read from their sources (a refusal across lines too). */
function momoCodes(): string[] {
  const found = new Set<string>();
  for (const f of fs.readdirSync(path.join(ROOT, 'host/src')).filter((n) => /^momo.*\.mjs$/.test(n)))
    for (const m of fs.readFileSync(path.join(ROOT, 'host/src', f), 'utf8').matchAll(/new HostRefusal\(\s*'([a-z][a-z0-9_]+)'/g))
      found.add(m[1]);
  // the rules of a move name theirs with `refuse('code', …)`, and the Host raises them as they are
  const rules = fs.readFileSync(path.join(ROOT, 'shared/host/momoMovePhases.mjs'), 'utf8');
  for (const m of rules.matchAll(/\brefuse\(\s*'([a-z][a-z0-9_]+)'/g)) found.add(m[1]);
  return [...found].sort();
}

test('every code MoMo’s Host files raise has words: one sentence of the real cause, a known action or none, and whether to try again', () => {
  const codes = momoCodes();
  assert.ok(codes.length >= 25, `the scan found ${codes.length} codes: its pattern no longer matches the sources`);
  for (const code of codes) {
    assert.ok(REFUSAL_CODES.includes(code), `${code} has no words`);
    const w = refusalWords(code, { machine: 'Studio', details: {}, message: "The Host's own sentence." })!;
    assert.ok(w, code);
    assert.match(w.line, /^[A-Z].*[.]$/, `${code}: a sentence`);
    assert.ok(w.line.length <= 120, `${code}: terse`);
    assert.ok(w.action === null || REFUSAL_ACTIONS.includes(w.action), `${code}: an action the app has`);
    assert.equal(typeof w.retry, 'boolean', code);
  }
});

test('the words name the machine and the other machine where that is the cause, and the Host’s own sentence where it is the only specific word', () => {
  const at = (code: string, extra: object = {}) => refusalWords(code, { machine: 'Studio', ...extra })!.line;
  assert.equal(at('momo_home_away'), "MoMo's home isn't running on Studio.");
  assert.equal(at('home_exists', { details: { name: 'Mac mini' } }), "MoMo's home is Mac mini, not Studio.");
  assert.equal(at('home_exists'), "MoMo's home is another machine, not Studio.");
  assert.equal(at('home_moved', { details: { name: 'Mac mini' } }), 'MoMo moved from Studio to Mac mini.');
  assert.equal(at('home_moved'), 'MoMo moved from Studio to another machine.');
  assert.equal(at('home_not_here'), "Studio isn't MoMo's home.");
  assert.match(at('move_not_given_up'), /stays paused on Studio/);
  assert.equal(at('momo_brain_unavailable', { message: 'That agent needs a provider.' }), 'Studio: That agent needs a provider.');
  assert.equal(at('momo_brain_unavailable'), "This agent can't be MoMo's brain on Studio.");
  assert.equal(
    at('move_in_progress', { message: 'Another move is open here and has not been settled with the other machine yet.' }),
    'Studio: Another move is open here and has not been settled with the other machine yet.',
  );
  assert.equal(at('move_in_progress'), 'Another move of MoMo started on Studio.');
  // what is worth trying again, and what is not
  const again = (code: string) => refusalWords(code, { machine: 'Studio' })!.retry;
  assert.deepEqual(
    ['turn_busy', 'home_lease_stale', 'move_expired', 'bundle_unreadable', 'momo_chat_not_started', 'momo_home_away'].map(again),
    [true, true, true, true, true, true],
  );
  assert.deepEqual(['turn_id_required', 'move_discarded', 'receipt_invalid', 'bundle_too_large', 'home_moved'].map(again), [
    false,
    false,
    false,
    false,
    false,
  ]);
});
