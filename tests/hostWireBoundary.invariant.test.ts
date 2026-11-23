// The wire boundary of a machine chat's message (#4916 sibling sweep): every key the app's delivery hands to host.send / host.start reaches the request, or is on the explicit "never sent" list. A key dropped silently (followUp and planBase were) fails here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { chatCalls } = require('../electron/host/remoteChatCalls.cjs');
const { deliverRemote } = require('../electron/host/remoteSendDelivery.cjs');

/** keys the delivery hands to a call that the Host must never see: `lendAs` names the agent a key is lent for (remoteCredentials reads it, the Mac keeps it) */
const NEVER_SENT = new Set(['lendAs']);
/** the queued option every key rides on: each is set below, so a new one the delivery forwards is caught by the key check */
const OPTS = { model: 'm-1', effort: 'high', human: true, steer: true, hostMode: 'plan', hostBase: 'auto-review', goal: true };

async function deliver(start?: object) {
  const asked: [string, any][] = [];
  const passed: Record<string, string[]> = {};
  const real = chatCalls({
    needs: () => undefined,
    request: async (method: string, params: any) => (asked.push([method, params]), { result: { accepted: true } }),
    epochOf: () => 1,
    mintKey: () => 'key-wire-boundary-mint',
    speaks: () => true,
  });
  const host: any = {
    ...real,
    send: (id: string, item: any, o: any) => ((passed.send = Object.keys(item)), real.send(id, item, o)),
    start: (id: string, item: any, o: any) => ((passed.start = Object.keys(item)), real.start(id, item, o)),
  };
  const entry = {
    chatId: 'c1',
    key: 'key-wire-entry-1',
    epoch: 1,
    state: 'queued',
    options: { item: { text: 'go', attachments: [], opts: OPTS }, start },
  };
  await deliverRemote(entry, { hostId: 'B', epoch: 1, folder: '/srv' }, host, {
    checks: { validate: async () => undefined },
    subscribed: async () => undefined,
    disposed: () => false,
    outbox: { pending: () => [{ key: 'key-wire-entry-1', state: 'queued' }] },
    ownerOf: () => ({ hostId: 'B', epoch: 1, folder: '/srv' }),
    state: () => ({ get: () => ({ pendingSwitch: { harness: 'acp:gemini' } }) }),
    projection: { remember: () => undefined, forget: () => undefined },
    hostFor: () => host,
    kindOf: () => 'codex',
  });
  return { asked, passed };
}

test('a message to a chat: every key the delivery passes is in the request or never sent', async () => {
  const { asked, passed } = await deliver();
  const req = asked.find(([m]) => m === 'chat.send')![1];
  const lost = passed.send.filter((k) => !(k in req) && !NEVER_SENT.has(k));
  assert.deepEqual(lost, [], `dropped before the wire: ${lost}`);
  for (const k of NEVER_SENT) assert.equal(k in req, false, `${k} reached the Host`);
  assert.deepEqual([req.model, req.effort, req.followUp, req.human, req.goal], ['m-1', 'high', 'steer', true, true]);
  // the mode and its Plan base are their own requests, base first, so the turn runs under the picked modes
  assert.deepEqual(
    asked.filter(([m]) => m === 'chat.permit').map(([, p]) => p.value),
    ['auto-review', 'plan'],
  );
});

test('the first message of a chat: every key the delivery passes is in the request or never sent', async () => {
  const { asked, passed } = await deliver({ harness: 'codex', projectId: 'p1', credential: { source: 'own' } });
  const req = asked.find(([m]) => m === 'chat.start')![1];
  const lost = passed.start.filter((k) => !(k in req) && !NEVER_SENT.has(k));
  assert.deepEqual(lost, [], `dropped before the wire: ${lost}`);
  assert.deepEqual(
    [req.permission, req.planBase, req.harness, req.projectId, req.credential, req.human],
    ['plan', 'auto-review', 'codex', 'p1', { source: 'own' }, true],
  );
  assert.equal(
    asked.some(([m]) => m === 'chat.permit'),
    false,
  );
});
