// A machine paired by code whose Host removed this Mac (#5747, electron/host/proofWatch.cjs): its relay link answers the proof with `unknown_client` marked `linkRemoved`; heard on the live connection or a one-off session, this app revokes its own relay pair for that machine, and the row is attention saying the machine removed this Mac with Remove as the fix, even once the machine reads offline. Any other refusal, or a machine not paired by code, revokes nothing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { createConnectionWatch, REMOVED_WORDS, proofLine } = require('../electron/host/proofWatch.cjs');
const { recentIgnored, clearIgnored } = require('../electron/ignored.cjs');

const tick = () => new Promise((r) => setImmediate(r));
const removedError = () =>
  Object.assign(new Error('This Mac removed this client.'), { code: 'unknown_client', details: { linkRemoved: true } });

/** A live connection as remote.cjs gives one: its state, and the proof answers it tells. */
function fakeHost() {
  const refused = new Set<(e: any) => void>();
  return {
    state: () => 'online',
    onState: () => () => undefined,
    onRefused: (fn: (e: any) => void) => (refused.add(fn), () => void refused.delete(fn)),
    status: async () => undefined,
    tell: (e: any) => {
      for (const fn of refused) fn(e);
    },
  };
}
function fakeRelay(fail: Error | null = null) {
  const marked = new Set<string>();
  return {
    asked: [] as string[],
    peerRemoved(this: any, id: string) {
      this.asked.push(id);
      if (fail) return Promise.reject(fail);
      marked.add(id);
      return Promise.resolve(true);
    },
    removedByPeer: (id: string) => marked.has(id),
  };
}
const row = (id: string, status = 'online') => ({ id, name: 'Studio', status, note: 'Via relay · Claude Code' });

test('a removed link heard on the live connection revokes this app’s pair for that machine, and its row says so with Remove as the fix', async (t) => {
  const relay = fakeRelay();
  let told = 0;
  const w = createConnectionWatch({ relay, onChange: () => void told++, onUp: () => undefined });
  const host = fakeHost();
  const stop = w.watch('relay:h_studio', host);
  t.after(stop);
  host.tell(removedError());
  await tick();
  assert.deepEqual(relay.asked, ['relay:h_studio']);
  assert.ok(told >= 2, 'the windows are told of the refusal and of the pair going');
  // offline too: the machine no longer reaches this Mac, yet the row still says why and what to do
  for (const status of ['online', 'offline'])
    assert.deepEqual(w.rows([row('relay:h_studio', status)]), [
      {
        ...row('relay:h_studio', status),
        status: 'attention',
        note: 'Studio removed this Mac. Remove it here, then pair again with a new code if you need it.',
        peerRemoved: true,
      },
    ]);
  assert.equal(REMOVED_WORDS('Studio'), w.rows([row('relay:h_studio')])[0].note);
});

test('nothing is revoked for another refusal, an accepted proof, a machine not paired by code, or without a relay', async (t) => {
  const relay = fakeRelay();
  const w = createConnectionWatch({ relay, onChange: () => undefined, onUp: () => undefined });
  const host = fakeHost();
  t.after(w.watch('relay:h_studio', host));
  host.tell(Object.assign(new Error('not paired'), { code: 'unknown_client' }));
  host.tell(null);
  const ssh = fakeHost();
  t.after(w.watch('ssh:me@studio', ssh));
  ssh.tell(removedError());
  const none = createConnectionWatch({ onChange: () => undefined, onUp: () => undefined });
  const alone = fakeHost();
  t.after(none.watch('relay:h_alone', alone));
  alone.tell(removedError());
  await tick();
  assert.deepEqual(relay.asked, []);
  // without a relay the refusal is still the #5744 line
  assert.equal(none.rows([row('relay:h_alone')])[0].note, proofLine('unknown_client', 'Studio'));
  assert.equal(w.rows([row('relay:h_studio')])[0].status, 'online', 'an accepted proof leaves the row as it is');
});

test('a one-off session refused as removed revokes the pair too; a revoke that fails is noted, never thrown', async () => {
  clearIgnored();
  const relay = fakeRelay(new Error('relay store unreadable'));
  const w = createConnectionWatch({ relay, onChange: () => undefined, onUp: () => undefined });
  const [, failed] = w.session('relay:h_studio', (s: any) => s);
  assert.throws(() => failed(removedError()), /removed this client/);
  await tick();
  assert.deepEqual(relay.asked, ['relay:h_studio']);
  assert.ok(recentIgnored().some((e: any) => /revoke the relay pair of a machine that removed this Mac/.test(JSON.stringify(e))));
  assert.equal(w.rows([row('relay:h_studio')])[0].peerRemoved, undefined, 'not marked while its pair could not be revoked');
});

test('a machine that removed this Mac is not asked again on the timer; one that refuses for another reason is', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const { PROOF_RETRY_MS } = require('../electron/host/proofWatch.cjs');
  const w = createConnectionWatch({ relay: fakeRelay(), onChange: () => undefined, onUp: () => undefined });
  const asked: string[] = [];
  const removed = { ...fakeHost(), status: async () => void asked.push('removed') };
  const other = { ...fakeHost(), status: async () => void asked.push('other') };
  t.after(w.watch('relay:h_removed', removed));
  t.after(w.watch('relay:h_other', other));
  other.tell(Object.assign(new Error('not paired'), { code: 'unknown_client' }));
  removed.tell(Object.assign(new Error('not paired'), { code: 'unknown_client' }));
  removed.tell(removedError());
  t.mock.timers.tick(PROOF_RETRY_MS);
  await tick();
  assert.deepEqual(asked, ['other']);
});
