// A controller paired by code on a served Host (#5738): the name the person approved is signed and never changes; the controller renaming itself changes nothing, while this Mac's own app (or the CLI) may label its row, which the list shows in its place; nobody else renames another client's row.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
// @ts-ignore: plain ESM without declarations
import { helloParams, parseParams } from '../shared/host/schema.mjs';
// @ts-ignore
import { readControllers } from '../host/src/trustState.mjs';
import { servedHost } from './support/hostClientsWorld.ts';
import { line } from './support/host-line.ts';

test('the wire: a rename names a row only by a valid fingerprint, or none for the caller’s own', () => {
  const fp = 'a'.repeat(64);
  assert.deepEqual(parseParams('host.clientRename', { name: 'Studio', fingerprint: fp }), { name: 'Studio', fingerprint: fp });
  assert.deepEqual(parseParams('host.clientRename', { name: 'Studio' }), { name: 'Studio' });
  assert.throws(() => parseParams('host.clientRename', { name: 'Studio', fingerprint: 'zz' }), /fingerprint/);
});

test('this Mac labels a code-paired controller’s row; the controller renaming itself keeps the approved name; a controller cannot rename another row', async (t) => {
  const w = await servedHost(t);
  const token = fs.readFileSync(`${w.paths.socketPath}.token`, 'utf8');
  const cli = line(w.paths.socketPath, token);
  t.after(cli.close);
  await cli.request('host.hello', helloParams());
  const ctlId = w.identity('other-mac');
  const ctl = w.pairing.add(ctlId.publicKey, { name: 'Other Mac', kind: 'controller', approval: { text: 'signed', sig: 'sig' } });
  const otherId = w.identity('third');
  const other = w.pairing.add(otherId.publicKey, { name: 'Third', kind: 'controller', approval: { text: 'signed', sig: 'sig' } });
  const rowOf = async (fp: string) => (await cli.request('host.clients')).clients.find((c: any) => c.fingerprint === fp);
  // this Mac's own label
  assert.deepEqual(await cli.request('host.clientRename', { fingerprint: ctl, name: 'Studio' }), { renamed: true });
  assert.equal((await rowOf(ctl)).name, 'Studio');
  const kept = readControllers(path.join(w.paths.configDir))[ctl];
  assert.deepEqual([kept.name, kept.label], ['Other Mac', 'Studio'], 'the approved name stays under the label');
  // the controller renaming itself changes nothing
  const conn = await w.reconnect(ctlId);
  assert.deepEqual(await conn.request('host.clientRename', { name: 'Hacked name' }), { renamed: true });
  assert.deepEqual([readControllers(w.paths.configDir)[ctl].name, (await rowOf(ctl)).name], ['Other Mac', 'Studio']);
  // nor may it rename another client's row
  await assert.rejects(conn.request('host.clientRename', { fingerprint: other, name: 'x' }), (e: any) => e.code === 'forbidden');
  // nor may a paired desktop (another Mac added over SSH is one): only the CLI on this machine labels rows
  const desk = await w.paired('ssh-mac', 'SSH Mac');
  await assert.rejects(desk.conn.request('host.clientRename', { fingerprint: ctl, name: 'x' }), (e: any) => e.code === 'forbidden');
  // an empty label shows the approved name again
  assert.deepEqual(await cli.request('host.clientRename', { fingerprint: ctl, name: '' }), { renamed: true });
  assert.equal((await rowOf(ctl)).name, 'Other Mac');
  assert.equal(readControllers(w.paths.configDir)[ctl].label, undefined);
  // a client that is not a controller is simply renamed by this Mac
  const phone = w.pairing.add(w.identity('phone').publicKey, { name: 'Pocket', kind: 'phone' });
  assert.deepEqual(await cli.request('host.clientRename', { fingerprint: phone, name: 'Pocket 2' }), { renamed: true });
  assert.equal((await rowOf(phone)).name, 'Pocket 2');
  assert.deepEqual(await cli.request('host.clientRename', { fingerprint: 'b'.repeat(64), name: 'x' }), { renamed: false });
});
