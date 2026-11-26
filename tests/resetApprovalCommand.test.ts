// The way out of a lost or replaced approval key (host/src/pairingCommands.mjs, `mopilot-host reset-approval`, slice 4 of #5576): with the key gone every controller is unbelieved yet still counted, so no key can be enrolled until the command removes the controllers with the key.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
// @ts-ignore: plain ESM without declarations
import { createApprovalKeys, ENROL_TAG } from '../host/src/codePairApproval.mjs';
// @ts-ignore
import { createPairing } from '../host/src/pairing.mjs';
// @ts-ignore
import { resetApprovalCommand } from '../host/src/pairingCommands.mjs';
// @ts-ignore
import { readControllers } from '../host/src/trustState.mjs';
import { tmpDir } from './support/hostClientsWorld.ts';

const helper = () => {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const jwk = publicKey.export({ format: 'jwk' }) as any;
  const point = Buffer.concat([Buffer.from([4]), Buffer.from(jwk.x, 'base64url'), Buffer.from(jwk.y, 'base64url')]).toString('base64');
  return {
    point,
    sign: (text: string) => crypto.sign('sha256', Buffer.from(text), { key: privateKey, dsaEncoding: 'der' }).toString('base64'),
  };
};
const peer = (n: number) => Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), Buffer.alloc(32, n)]).toString('base64');

function world(t: any) {
  const dir = tmpDir(t);
  const configDir = path.join(dir, 'config');
  const pairing = createPairing({ configDir });
  const keys = createApprovalKeys({
    configDir,
    hostId: () => 'host-h',
    controllers: () => pairing.controllerRecords(),
    platform: 'darwin',
  });
  const h = helper();
  const enrol = () => keys.enrol({ key: h.point, weak: false, signature: h.sign([ENROL_TAG, 'host-h', h.point, 'strong'].join('|')) });
  const lines: string[] = [];
  const errs: string[] = [];
  const run = (argv: string[]) =>
    resetApprovalCommand({ argv, configDir, out: (l: string) => lines.push(l), err: (l: string) => errs.push(l) });
  return { configDir, pairing, keys, enrol, run, lines, errs, keyFile: path.join(configDir, 'approval-key.json') };
}

test('without --yes nothing is removed and the command says what it would remove', (t) => {
  const w = world(t);
  w.enrol();
  w.pairing.add(peer(1), { name: 'A', kind: 'controller', link: 'h_abcdefghijklmnop' });
  assert.equal(w.run([]), 1);
  assert.match(w.errs.join(' '), /now 1\b/);
  assert.ok(fs.existsSync(w.keyFile));
  assert.equal(Object.keys(readControllers(w.configDir)).length, 1);
});

test('after the key is lost no key can be enrolled while controllers are counted; reset-approval removes the key and every controller, leaves their relay links as tombstones, and a key can be enrolled again', (t) => {
  const w = world(t);
  w.enrol();
  const a = w.pairing.add(peer(1), { name: 'A', kind: 'controller', link: 'h_aaaaaaaaaaaaaaaa' });
  // a record edited by hand to name the Mac app's own link: that link is not a controller's, so it is never retired
  w.pairing.add(peer(2), { name: 'B', kind: 'controller', link: 'h_appown0000000000' });
  fs.writeFileSync(
    path.join(w.configDir, 'relay.json'),
    JSON.stringify({
      version: 1,
      links: [
        { hostId: 'h_aaaaaaaaaaaaaaaa', relayUrl: 'wss://r', secret: 's', pairId: 'p', root: 'r', kind: 'controller' },
        { hostId: 'h_appown0000000000', relayUrl: 'wss://r', secret: 's', pairId: 'p', root: 'r' },
      ],
    }),
  );
  fs.rmSync(w.keyFile); // the key is lost
  assert.deepEqual(w.keys.status(), { available: false, reason: 'no_approval_helper' });
  assert.throws(() => w.enrol(), { code: 'controllers_exist' }, 'the lockout');
  assert.equal(w.run(['--yes']), 0, w.errs.join());
  assert.match(w.lines.join('\n'), /controllers: 2, relay links: 1/);
  assert.equal(Object.keys(readControllers(w.configDir)).length, 0);
  assert.equal(Object.hasOwn(readControllers(w.configDir), a), false);
  // the controller's link stays as a tombstone (it only tells that Mac it was removed); another client's link is untouched
  const links = JSON.parse(fs.readFileSync(path.join(w.configDir, 'relay.json'), 'utf8')).links;
  assert.deepEqual(
    links.map((l: any) => [l.hostId, typeof l.retiredAt]),
    [
      ['h_aaaaaaaaaaaaaaaa', 'number'],
      ['h_appown0000000000', 'undefined'],
    ],
  );
  assert.equal(w.run(['--yes']), 0, 'a second reset finds the tombstone already made');
  assert.match(w.lines.at(-2) as string, /relay links: 0/);
  assert.deepEqual(w.enrol(), { enrolled: true, weak: false });
});

test('with a key and no controllers it only removes the key; with nothing it is a no-op; an unreadable relay.json stops it before anything is removed', (t) => {
  const w = world(t);
  w.enrol();
  assert.equal(w.run(['--yes']), 0);
  assert.match(w.lines.join(' '), /controllers: 0, relay links: 0/);
  assert.ok(!fs.existsSync(w.keyFile));
  assert.equal(w.run(['--yes']), 0, 'nothing to remove');
  const x = world(t);
  x.enrol();
  x.pairing.add(peer(3), { name: 'C', kind: 'controller', link: 'h_cccccccccccccccc' });
  fs.writeFileSync(path.join(x.configDir, 'relay.json'), '{');
  assert.equal(x.run(['--yes']), 1);
  assert.match(x.errs.join(' '), /Could not reset: .*cannot be read/);
  assert.ok(fs.existsSync(x.keyFile), 'the key is kept');
  assert.equal(Object.keys(readControllers(x.configDir)).length, 1, 'and so is the controller: nothing is half done');
});

test("the Host command line routes `reset-approval` to the command, with the Host's own config folder, and lists it in its usage", async (t) => {
  // @ts-ignore
  const { main } = await import('../host/src/cli.mjs');
  const dir = path.join(tmpDir(t), 'data');
  const out: string[] = [];
  const err: string[] = [];
  const code = await main(['reset-approval', '--yes', '--data-dir', dir], {
    out: (l: string) => out.push(l),
    err: (l: string) => err.push(l),
    env: {},
  });
  assert.equal(code, 0, err.join());
  assert.match(out.join('\n'), /Removed the approval key/);
  const pair: string[] = [];
  assert.equal(await main(['pair', '--data-dir', dir], { out: (l: string) => pair.push(l), err: (l: string) => pair.push(l), env: {} }), 0);
  assert.match(pair.join('\n'), /^Pairing code: \S+/);
  const usage: string[] = [];
  await main([], { out: (l: string) => usage.push(l), err: (l: string) => usage.push(l), env: {} });
  assert.match(usage.join('\n'), /reset-approval/);
});

test('a Host whose key is enrolled but whose controller records no longer verify (out of sync) is reset completely by the command: no record is left to block the next key', (t) => {
  const w = world(t);
  w.enrol();
  // records with no proof the key verifies: a Host that pairs by code believes none of them
  w.pairing.add(peer(1), { name: 'A', kind: 'controller' });
  w.pairing.add(peer(2), { name: 'B', kind: 'controller' });
  assert.throws(() => w.enrol(), { code: 'already_enrolled' });
  assert.equal(w.run(['--yes']), 0, w.errs.join());
  assert.deepEqual(readControllers(w.configDir), {});
  assert.deepEqual(w.enrol(), { enrolled: true, weak: false }, 'a new key is enrolled at once');
});
