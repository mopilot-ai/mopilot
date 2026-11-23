// Pushing from a Host's relay link (P4): phone enrollments are the push targets, a push rides that enrollment's own link, and the status names the client.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRelayLinks } from '../host/src/relayLink.mjs';
import { toBase64 } from '../shared/remote/envelope.mjs';

function rig() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-push-'));
  const root = new Uint8Array(32).fill(5);
  const links = [
    { relayUrl: 'wss://r/', hostId: 'mac', secret: 's1', pairId: 'pm', root: toBase64(root) },
    { relayUrl: 'wss://r/', hostId: 'ph', secret: 's2', pairId: 'pp', root: toBase64(root), client: 'fp' },
  ];
  fs.writeFileSync(path.join(dir, 'relay.json'), JSON.stringify({ version: 1, links }));
  const sockets: any[] = [];
  const l = createRelayLinks({
    configDir: dir,
    socketPath: path.join(dir, 'x.sock'),
    createSocket: () => {
      const s: any = {
        sent: [],
        readyState: 1,
        send(t: string) {
          s.sent.push(t);
        },
        close() {},
        addEventListener() {},
        removeEventListener() {},
      };
      sockets.push(s);
      return s;
    },
  });
  l.start();
  return { l, dir, sockets };
}

test('only phone enrollments are push targets, and the status names the client', () => {
  const { l } = rig();
  assert.deepEqual(
    l.pushTargets().map((t) => [t.hostId, t.pairId, t.root.length]),
    [['ph', 'pp', 32]],
  );
  assert.deepEqual(
    l.status().links.map((x: any) => [x.hostId, x.client]),
    [
      ['mac', undefined],
      ['ph', 'fp'],
    ],
  );
  l.close();
});

test('a push to a gone enrollment is refused; a kept client survives enroll', async () => {
  const { l } = rig();
  await assert.rejects(l.push('nope', { pair: 'pp', kind: 'needsYou', ref: 'r' }), /gone/);
  const kept = l.enroll({
    relayUrl: 'wss://r/',
    hostId: 'new',
    secret: 's',
    pairId: 'pn',
    appPub: toBase64(new Uint8Array(32).fill(9)),
    appEphPub: toBase64(new Uint8Array(32).fill(8)),
    client: 'fp2',
  });
  assert.ok(kept.hostPub);
  assert.ok(l.pushTargets().some((t) => t.hostId === 'new'));
  const plain = l.enroll({
    relayUrl: 'wss://r/',
    hostId: 'plain',
    secret: 's',
    pairId: 'pq',
    appPub: toBase64(new Uint8Array(32).fill(9)),
    appEphPub: toBase64(new Uint8Array(32).fill(8)),
  });
  assert.ok(plain.hostPub);
  assert.ok(!l.pushTargets().some((t) => t.hostId === 'plain'));
  l.close();
});

test("a push on an existing link goes to that link's relay client", async () => {
  const { l } = rig();
  const p = l.push('ph', { pair: 'pp', kind: 'needsYou', ref: 'r', sealed: 'x' });
  // the relay is not connected in this rig, so the request is refused rather than queued: the notifier retries
  await assert.rejects(p, /not connected/);
  l.close();
});
