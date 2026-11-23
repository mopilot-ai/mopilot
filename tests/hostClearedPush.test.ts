// What a phone's lock screen says when a Host's waiting card is cleared while its turn keeps running (#4752): the Host's real notifier feeds the relay's real rule and APNs body, and nothing it shows claims the chat finished.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createPushNotifier } from '../host/src/pushNotifier.mjs';
import { Notifier, TITLES } from '../relay/src/notifier.mjs';
import { apnsBody } from '../relay/src/pushPayload.mjs';

const card = { requestId: 'q1', rev: 1, cardKind: 'permission', summary: { tool: 'execute', line: 'npm test' } };

/** The Host's pushes for one chat, each carried through the relay's notifier and shaped into the APNs body the phone receives. */
async function lockScreen(events: { kind: string; chatId: string; card?: typeof card }[]) {
  const requests: { kind: string; ref: string; sealed?: string }[] = [];
  const host = createPushNotifier({
    targets: () => [{ hostId: 'h1', pairId: 'p_pair00001', root: new Uint8Array(32).fill(7) }],
    send: async (_hostId: string, req: any) => (requests.push(req), 'sent'),
    machineName: () => 'build-box',
  });
  for (const e of events) await host.notify(e);
  host.close();
  const relay = new Notifier();
  let at = 1000;
  return requests.map((req) => {
    // a Host's own push: the relay holds nothing back and applies no repeat window (fromHost)
    const shown = relay.push(req.kind, `p_pair00001:${req.ref}`, (at += 5000), true)!;
    const collapseId = createHash('sha256').update(`p_pair00001:${req.ref}`).digest('hex').slice(0, 32);
    return {
      kind: req.kind,
      body: apnsBody({
        platform: 'apns',
        token: 't',
        kind: req.kind,
        title: shown.title,
        count: 1,
        collapseId,
        ref: req.ref,
      } as any) as any,
    };
  });
}

test('a card answered elsewhere while the turn keeps running withdraws "needs you" without saying the chat finished', async () => {
  const shown = await lockScreen([
    { kind: 'needsYou', chatId: 'c1', card },
    { kind: 'cleared', chatId: 'c1' },
  ]);
  assert.equal(shown.length, 2);
  const [waiting, cleared] = shown;
  assert.equal(waiting.body.aps.alert.title, TITLES.needsYou);
  // what it says is true whatever happened to the card: the chat is still running, so it is never "finished"
  // (that it replaces the waiting notification is the relay's collapse id: tests/relayPush.test.ts)
  assert.notEqual(cleared.body.aps.alert.title, TITLES.done, 'the turn is still running');
  assert.notEqual(cleared.kind, 'done');
  assert.match(cleared.body.aps.alert.title, /no longer needs you/i);
  // quiet and without buttons: a clearing is not something to answer, and the waiting notification's Allow/Deny must go with it
  assert.equal(cleared.body.aps['interruption-level'], 'passive');
  assert.equal(cleared.body.aps.category, undefined);
  assert.equal(cleared.body.aps.sound, undefined);
  assert.equal(cleared.body.aps['mutable-content'], undefined);
});

test('a clearing carries no sealed blob, and a Host’s pushes are only the needs-you kind and the clearing', async () => {
  const shown = await lockScreen([
    { kind: 'needsYou', chatId: 'c1', card },
    { kind: 'reminder', chatId: 'c1' },
    { kind: 'paused', chatId: 'c1' },
    { kind: 'cleared', chatId: 'c1' },
  ]);
  assert.deepEqual(
    shown.map((s) => s.kind),
    ['needsYou', 'needsYou', 'needsYou', 'cleared'],
  );
  assert.equal(shown[3].body.st, undefined);
  // every title a Host push shows is one of the relay's fixed texts: nothing the Host wrote reaches a lock screen
  const fixed = new Set(Object.values(TITLES));
  for (const s of shown) assert.ok(fixed.has(s.body.aps.alert.title), s.body.aps.alert.title);
});
