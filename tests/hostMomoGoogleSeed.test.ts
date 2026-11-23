// The seed of MoMo's Google service (host/src/momoGoogle.mjs `seed`, for the move check): it fills an empty home with one record of each file, and never writes over a client, an account or cursors a person already has.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { signInToGoogle } from '../shared/momoGoogle/signIn.mjs';
import { fakeCatcher, homeWorld, sealer } from './support/momoGoogleHostKit.ts';

const FILES = ['google-account.sealed', 'google-clients.sealed', 'google-versions.sealed'];
const bytes = (dir: string) =>
  Object.fromEntries(FILES.map((f) => [f, fs.existsSync(path.join(dir, f)) ? fs.readFileSync(path.join(dir, f), 'utf8') : null]));

test('an empty home is seeded with one record in each of the three files', async (t) => {
  const w = await homeWorld(t);
  await w.google.seed();
  const seeded = bytes(path.join(w.momoDir, 'google'));
  assert.deepEqual(
    Object.values(seeded).map((v) => typeof v),
    ['string', 'string', 'string'],
  );
  assert.equal((await w.google.status()).kind, 'connected_read_only');
});

test('a connected account is left exactly as it is: no file is written, the account is the same', async (t) => {
  const w = await homeWorld(t);
  await w.google.configure({ desktopJson: w.json });
  const host = { call: (op: string, p: object = {}) => (w.google as any)[op]({ op, ...p }) };
  assert.equal(
    (await signInToGoogle({ host, startCatcher: fakeCatcher(() => ({ code: 'c' })), sealer, purpose: 'read', client: 'desktop' })).ok,
    true,
  );
  await (await w.google.reader()).versions.set('gmail:real', 'v9');
  await w.google.pause();
  const dir = path.join(w.momoDir, 'google');
  const before = bytes(dir);
  const status = await w.google.status();
  await w.google.seed();
  assert.deepEqual(bytes(dir), before, 'not one of the three files changed');
  assert.deepEqual(await w.google.status(), status);
  assert.equal((status as { email: string }).email, 'me@example.com');
});

test('a configured client with no account, and cursors with nothing else, are not replaced either', async (t) => {
  const withClient = await homeWorld(t);
  await withClient.google.configure({ desktopJson: withClient.json });
  const dir = path.join(withClient.momoDir, 'google');
  const before = bytes(dir);
  await withClient.google.seed();
  assert.deepEqual(bytes(dir), before);
  assert.equal((await withClient.google.status()).kind, 'not_connected');

  const cursorsOnly = await homeWorld(t);
  const g = cursorsOnly.google;
  await g.configure({ desktopJson: cursorsOnly.json });
  await (await g.reader()).versions.set('gmail:t', 'v');
  await g.pause();
  fs.rmSync(path.join(cursorsOnly.momoDir, 'google', 'google-clients.sealed'));
  await g.pause();
  const kept = bytes(path.join(cursorsOnly.momoDir, 'google'));
  await g.seed();
  assert.deepEqual(bytes(path.join(cursorsOnly.momoDir, 'google')), kept);
});
