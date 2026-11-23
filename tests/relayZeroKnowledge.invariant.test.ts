// Zero knowledge, measured (design/mobile-remote): a recorded multi-message session runs through the relay and every byte
// its Postgres holds is searched for the plaintext the Mac and the phone exchanged. The store may hold only ciphertext,
// sizes, counters and timestamps; a new column that could hold anything else must be added to SCHEMA below on purpose.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { makeDb, makeHub, settle } from './support/relayKit.ts';

/** The relay is code under relay/; the rig that drives it is the shared kit. */
export const GUARDS = ['relay/', 'tests/support/relayKit.ts'];

/** Every column the relay's database may have, with its type. `text` is for ids, a direction, a platform and a push token only. */
const SCHEMA: Record<string, string> = {
  'relay_pairs.pair_id': 'text',
  'relay_pairs.user_id': 'text',
  'relay_pairs.mac_device_id': 'text',
  'relay_pairs.phone_device_id': 'text',
  'relay_pairs.join_deadline': 'timestamp with time zone',
  'relay_pairs.created_at': 'timestamp with time zone',
  'relay_pairs.joined_at': 'timestamp with time zone',
  'relay_mailbox.id': 'bigint',
  'relay_mailbox.pair_id': 'text',
  'relay_mailbox.dir': 'text',
  'relay_mailbox.ctr': 'bigint',
  'relay_mailbox.nonce': 'bytea',
  'relay_mailbox.box': 'bytea',
  'relay_mailbox.size': 'integer',
  'relay_mailbox.created_at': 'timestamp with time zone',
  'relay_mailbox.expires_at': 'timestamp with time zone',
  'relay_drops.id': 'bigint',
  'relay_drops.pair_id': 'text',
  'relay_drops.dir': 'text',
  'relay_drops.dropped': 'integer',
  'relay_drops.first_ctr': 'bigint',
  'relay_drops.last_ctr': 'bigint',
  'relay_drops.at': 'timestamp with time zone',
  'relay_push_tokens.device_id': 'text',
  'relay_push_tokens.user_id': 'text',
  'relay_push_tokens.platform': 'text',
  'relay_push_tokens.token': 'text',
  // the APNs topic (an app's bundle id) of the credential set that last sent to the token: configuration, never content
  'relay_push_tokens.topic': 'text',
  'relay_push_tokens.updated_at': 'timestamp with time zone',
  'relay_activity_tokens.device_id': 'text',
  'relay_activity_tokens.user_id': 'text',
  'relay_activity_tokens.token': 'text',
  'relay_activity_tokens.topic': 'text',
  'relay_activity_tokens.updated_at': 'timestamp with time zone',
  'relay_revoked_devices.device_id': 'text',
  'relay_revoked_devices.user_id': 'text',
  'relay_revoked_devices.revoked_at': 'timestamp with time zone',
  // an account whose relay access the account service switched off: its id and when
  'relay_disabled_accounts.user_id': 'text',
  'relay_disabled_accounts.disabled_at': 'timestamp with time zone',
  // a Host's relay credential: ids, the SHA-256 of the secret (never the secret), timestamps
  'relay_hosts.host_id': 'text',
  'relay_hosts.user_id': 'text',
  'relay_hosts.owner_device_id': 'text',
  'relay_hosts.pair_id': 'text',
  'relay_hosts.secret_hash': 'bytea',
  'relay_hosts.created_at': 'timestamp with time zone',
  'relay_hosts.last_seen_at': 'timestamp with time zone',
};

/** What the people on each side typed and the Mac answered: none of it may ever appear in the relay's store. */
const SECRETS = [
  'rm -rf ~/Documents/tax-2029.xlsx',
  'Refactor the billing module for ACME-CORP-SECRET',
  '/Users/alice/projects/acme/.env',
  'ghp_exampleExampleExampleExample0123456789',
  'MoMo remembers: Alice is meeting the lawyer on Tuesday',
  'Chat title: Quarterly layoffs plan',
];

const key = randomBytes(32);
/** What the endpoints do: seal on one side, open on the other. The relay never has `key`. */
function seal(plain: string) {
  const nonce = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key, nonce);
  const box = Buffer.concat([c.update(plain, 'utf8'), c.final(), c.getAuthTag()]);
  return { nonce: nonce.toString('base64'), box: box.toString('base64') };
}
function open(m: { nonce: string; box: string }) {
  const box = Buffer.from(m.box, 'base64');
  const d = createDecipheriv('aes-256-gcm', key, Buffer.from(m.nonce, 'base64'));
  d.setAuthTag(box.subarray(box.length - 16));
  return Buffer.concat([d.update(box.subarray(0, box.length - 16)), d.final()]).toString('utf8');
}

/** Every row of every table as text in three spellings, plus the database's raw files: what a stolen disk or a SQL dump would show. */
async function dump(db: any) {
  const tables = (await db.query("SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'")).rows.map(
    (r: any) => r.table_name,
  );
  const rows: unknown[] = [];
  for (const t of tables) rows.push([t, (await db.query(`SELECT * FROM ${t}`)).rows]);
  const asJson = JSON.stringify(rows, (_k, v) =>
    v instanceof Uint8Array
      ? { hex: Buffer.from(v).toString('hex'), b64: Buffer.from(v).toString('base64'), utf8: Buffer.from(v).toString('latin1') }
      : v,
  );
  const files = Buffer.from(await (await db.dumpDataDir('none')).arrayBuffer());
  return { asJson, files };
}
const leaks = (d: { asJson: string; files: Buffer }, secret: string) =>
  d.asJson.includes(secret) ||
  d.asJson.includes(Buffer.from(secret).toString('hex')) ||
  d.asJson.includes(Buffer.from(secret).toString('base64')) ||
  d.files.includes(Buffer.from(secret));

const { db, reset } = await makeDb();

test('the schema has no column that could hold plaintext: bytea only for nonce and box, text only for ids, direction, platform, token and APNs topic', async () => {
  const { rows } = await db.query(
    "SELECT table_name, column_name, data_type FROM information_schema.columns WHERE table_schema = 'public'",
  );
  const actual = Object.fromEntries(rows.map((r: any) => [`${r.table_name}.${r.column_name}`, r.data_type]));
  assert.deepEqual(actual, SCHEMA);
});

test('a recorded session leaves only ciphertext, sizes, counters and timestamps in the database', async () => {
  await reset();
  const r = makeHub(db);
  const P = 'p_recorded01';
  const mac = await r.join('u1', 'mac1', 'desktop');
  const phone = await r.join('u1', 'ph1', 'phone');
  await mac.say({ t: 'pair.register', pair: P });
  await phone.say({ t: 'pair.join', pair: P });
  await phone.say({ t: 'push.register', platform: 'apns', token: 'apns-device-token-0001' });

  // 1. both online: live frames in both directions
  await phone.say({ t: 'frame', pair: P, dir: 'p2m', ctr: 1, ...seal(SECRETS[0]) });
  await mac.say({ t: 'frame', pair: P, dir: 'm2p', ctr: 1, ...seal(SECRETS[1]) });
  // 2. the phone goes away; the Mac keeps talking, the frames wait in the mailbox; a push request carries a chat handle in the clear
  phone.h.close(1001);
  await settle(r.hub);
  await mac.say({ t: 'frame', pair: P, dir: 'm2p', ctr: 2, ...seal(SECRETS[2]) });
  await mac.say({ t: 'frame', pair: P, dir: 'm2p', ctr: 3, ...seal(SECRETS[3]) });
  await mac.say({ t: 'push', pair: P, kind: 'needsYou', ref: SECRETS[5] });
  const midway = await dump(db);
  assert.equal((await db.query('SELECT count(*)::int AS n FROM relay_mailbox')).rows[0].n, 2);
  // 3. the phone returns and drains; one more frame from the phone waits for a Mac that left
  const back = await r.join('u1', 'ph1', 'phone');
  assert.deepEqual(
    back.socket.of('frame').map((f) => open(f)),
    [SECRETS[2], SECRETS[3]],
  );
  mac.h.close(1000);
  await settle(r.hub);
  await back.say({ t: 'frame', pair: P, dir: 'p2m', ctr: 2, ...seal(SECRETS[4]) });
  const waiting = await dump(db);
  assert.equal((await db.query('SELECT count(*)::int AS n FROM relay_mailbox')).rows[0].n, 1);
  // 4. a week passes with the phone away: the waiting frame is dropped and only the notice (a count and counters) remains
  back.h.close(1001);
  await settle(r.hub);
  r.clock.advance(8 * 24 * 3600_000);
  await r.hub.sweep();
  const swept = await dump(db);

  for (const [label, d] of Object.entries({ midway, waiting, swept })) {
    for (const s of SECRETS) assert.equal(leaks(d, s), false, `${label}: the store holds "${s}"`);
  }
  assert.deepEqual((await db.query('SELECT 1 FROM relay_mailbox')).rows, []);
  const drops = (await db.query('SELECT dir, dropped, first_ctr, last_ctr FROM relay_drops')).rows;
  assert.deepEqual(
    drops.map((d: any) => [d.dir, d.dropped, Number(d.first_ctr), Number(d.last_ctr)]),
    [['p2m', 1, 2, 2]],
  );
});

test('a Host push on a phone’s lane leaves no clear text: the relay keeps the same columns and none of the sealed or planted text', async () => {
  await reset();
  const r = makeHub(db);
  const HOST = 'h_host0000000000001';
  const phone = await r.lane('u1', 'ph1');
  await r.hub.push.register({ deviceId: 'ph1', userId: 'u1', platform: 'apns', token: 'apns-device-token-0001' });
  await phone.say({ t: 'host.register', host: HOST, pair: 'p_hostrec001', hash: 'a'.repeat(64) });
  const host = await r.host(HOST);
  await host.say({ t: 'frame', pair: 'p_hostrec001', dir: 'p2m', ctr: 1, ...seal(SECRETS[0]) });
  await host.say({ t: 'push', pair: 'p_hostrec001', kind: 'needsYou', ref: 'opaque-ref-1', sealed: seal(SECRETS[1]).box });
  await host.say({ t: 'activity', pair: 'p_hostrec001', state: { needs: 1, running: 0, kind: 'needs', since: 0, at: 0, rows: [] } });
  await settle(r.hub);
  assert.equal(r.pushed.length >= 1, true, 'the push reached the sender');
  const d = await dump(db);
  for (const s of SECRETS) assert.equal(leaks(d, s), false, `the store holds "${s}"`);
  assert.equal(leaks(d, seal(SECRETS[1]).box), false, 'the sealed blob is not stored');
});

test('queued rows hold exactly the sealed bytes the sender sent, their size and expiry; nothing else about the message', async () => {
  await reset();
  const r = makeHub(db);
  const P = 'p_recorded02';
  const mac = await r.join('u1', 'mac1', 'desktop');
  const phone = await r.join('u1', 'ph1', 'phone');
  await mac.say({ t: 'pair.register', pair: P });
  await phone.say({ t: 'pair.join', pair: P });
  phone.h.close(1001);
  await settle(r.hub);
  const sealed = seal(SECRETS[1]);
  await mac.say({ t: 'frame', pair: P, dir: 'm2p', ctr: 41, ...sealed });
  const { rows } = await db.query('SELECT * FROM relay_mailbox');
  assert.equal(rows.length, 1);
  const row = rows[0];
  assert.deepEqual(Object.keys(row).sort(), ['box', 'created_at', 'ctr', 'dir', 'expires_at', 'id', 'nonce', 'pair_id', 'size']);
  assert.ok(Buffer.from(row.box).equals(Buffer.from(sealed.box, 'base64')));
  assert.equal(row.size, Buffer.from(sealed.box, 'base64').length);
  assert.equal(Number(row.ctr), 41);
  assert.equal(new Date(row.expires_at).getTime() - new Date(row.created_at).getTime(), 7 * 24 * 3600_000);
  for (const s of SECRETS) assert.equal(leaks(await dump(db), s), false);
  // the endpoint that holds the key reads it
  const back = await r.join('u1', 'ph1', 'phone');
  assert.equal(open(back.socket.of('frame')[0]), SECRETS[1]);
});

test('the leak detector finds plaintext in a column, in a bytea and in the raw files, so a clean result means something', async () => {
  await reset();
  await db.exec('CREATE TABLE leak_text (v text); CREATE TABLE leak_bytes (v bytea)');
  try {
    await db.query('INSERT INTO leak_text VALUES ($1)', [SECRETS[0]]);
    await db.query('INSERT INTO leak_bytes VALUES ($1)', [Buffer.from(SECRETS[1])]);
    const d = await dump(db);
    assert.equal(leaks(d, SECRETS[0]), true);
    assert.equal(leaks(d, SECRETS[1]), true);
    assert.equal(leaks(d, SECRETS[2]), false);
    assert.equal(d.files.includes(Buffer.from(SECRETS[0])), true);
  } finally {
    await db.exec('DROP TABLE leak_text; DROP TABLE leak_bytes');
  }
});
