// The dev host's `--qr-account <user-id>[:<email>]` (#5320): the pairing QR names an account the way a signed-in Mac's does (acct, who), so a simulator can show the phone's "a computer on another account" card at the scan; without it the QR names none, as before.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { sha256 } from '@noble/hashes/sha256';
import { startHost } from '../scripts/mobile-dev-host/host.mjs';
import { main } from '../scripts/mobile-dev-host/cli.mjs';
import { accountId } from '../shared/remote/accountHint.mjs';

const scratch = mkdtempSync(path.join(tmpdir(), 'dev-host-qr-account-'));
after(() => rmSync(scratch, { recursive: true, force: true }));

async function qrOf(name: string, extra: object = {}) {
  const host = await startHost({
    dir: path.join(scratch, name),
    advertise: '127.0.0.1',
    bind: '127.0.0.1',
    port: 0,
    out: () => undefined,
    sleep: async () => undefined,
    env: {},
    ...extra,
  });
  try {
    return JSON.parse((await host.pair()).qr);
  } finally {
    await host.stop();
  }
}

test('the QR names the account it is given: eight hashed bytes of the id, and the masked email', async () => {
  const qr = await qrOf('named', { qrAccount: { id: 'someone-else', email: 'someone@example.com' } });
  assert.equal(qr.acct, accountId('someone-else', sha256));
  assert.equal(qr.who, 's***@example.com');
});

test('the dev account itself gives the hint that matches the phone, and with no account the QR names none', async () => {
  const same = await qrOf('same', { qrAccount: { id: 'dev-user' } });
  assert.equal(same.acct, accountId('dev-user', sha256));
  assert.equal('who' in same, false, 'no email, no masked address');
  const none = await qrOf('none');
  assert.equal('acct' in none, false);
  assert.equal('who' in none, false);
});

test('the console reads <user-id>[:<email>], keeping the colons of the email, and refuses an empty id', async () => {
  const calls: any[] = [];
  const io: any = {
    stdin: { on: () => undefined, setEncoding: () => undefined, resume: () => undefined, pause: () => undefined },
    out: () => undefined,
    lan: () => '127.0.0.1',
    start: async (o: any) => {
      calls.push(o);
      throw new Error('stop here');
    },
    writeCode: async () => undefined,
  };
  await assert.rejects(main(['--qr-account', 'other:a:b@example.com'], io), /stop here/);
  assert.deepEqual(calls[0].qrAccount, { id: 'other', email: 'a:b@example.com' });
  await assert.rejects(main(['--qr-account', 'other'], io), /stop here/);
  assert.deepEqual(calls[1].qrAccount, { id: 'other' });
  await assert.rejects(main(['--qr-account', ':x@example.com'], io), /needs a user id/);
  assert.equal(calls.length, 2, 'an empty id starts nothing');
});
