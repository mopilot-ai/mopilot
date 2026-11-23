// Moving MoMo's home between two Hosts (host/src/momoMove.mjs, momoBundle.mjs, shared/momoMove.mjs): two real homes over two folders and two key files, driven the way the app drives them.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
// @ts-ignore: plain ESM without declarations
import { createMomoHome } from '../host/src/momoHome.mjs';
// @ts-ignore
import { createMomoMove, MAX_BUNDLE_BYTES } from '../host/src/momoMove.mjs';
// @ts-ignore
import { sealBundle, newMoveKey, openBundle, safeRel, collectFiles } from '../host/src/momoBundle.mjs';
// @ts-ignore
import { createFileSafeStorage } from '../host/src/secretStore.mjs';
// @ts-ignore
import { moveHome, finishOld, MOVE_STEPS } from '../shared/momoMove.mjs';
import { servedHost } from './support/hostClientsWorld.ts';
// @ts-ignore
import { momoHomeFor, createMomoHidden } from '../host/src/momoWiring.mjs';
// @ts-ignore
import { helloParams } from '../shared/host/schema.mjs';

import { MOMO, A, B, host, studio } from './support/host/momoMoveWorld.ts';

/** A Host or just its two calls (a test's own fake). */
const sideOf = (x: any) => x.side ?? x;
const run = (a: any, b: any, extra: object = {}): Promise<any> =>
  moveHome({ moveId: 'move-0001', from: sideOf(a), to: sideOf(b), target: B, fromName: A.name, ...extra });

test('a move carries the facts, the audit chain and the turns to the new home, which runs at the next epoch; the old one keeps only a tombstone and its key is gone', async (t) => {
  const a = await studio(t);
  const b = await host(t, B);
  const steps: string[] = [];
  const r = await run(a, b, { step: (s: string) => steps.push(s) });
  assert.deepEqual(
    { ...r, receipt: typeof r.receipt },
    { ok: true, oldHome: 'cleared', leaseEpoch: 2, receipt: 'string', homeId: B.homeId },
  );
  assert.deepEqual(steps, ['paused', 'sealed', 'copied', 'switching', 'resuming', 'cleaning-up']);
  assert.deepEqual(MOVE_STEPS, steps);
  // the new home runs at epoch 2 with what the old one knew
  const home = b.home.status().home;
  assert.deepEqual(
    [home.homeId, home.leaseEpoch, home.state, home.moveId, home.movedTo],
    [B.homeId, 2, 'running', 'move-0001', null],
    'the lease remembers the move that made it',
  );
  assert.match(home.bundleHash, /^[0-9a-f]{64}$/);
  const s = b.home.stores()!;
  assert.deepEqual(
    s.memory.list().facts.map((f: any) => f.text),
    ['Lives in Berlin'],
  );
  assert.equal((await s.audit.verify()).ok, true, 'the chain goes on from the old home');
  const exported = await s.audit.exportJsonl();
  assert.match(exported, /momo\.home\.moved/);
  assert.equal(s.turns.status('key-00000001').state, 'interrupted', 'a turn in flight is parked, never replayed');
  // the old home is no home, at the new epoch, with its data and its key deleted
  const old = a.home.status().home;
  assert.deepEqual([old.homeId, old.state, old.leaseEpoch, old.movedTo.name, old.movedTo.homeId], [null, 'none', 2, B.name, B.homeId]);
  assert.equal(a.home.stamp(), null);
  assert.equal(a.home.stores(), null);
  assert.deepEqual(fs.readdirSync(a.momoDir).sort(), ['grant.json', 'home.json'], 'only what the Host keeps for itself');
  assert.equal(fs.existsSync(a.dataKeyDir), false, 'the key is gone, so what is left is unreadable');
  // a stamp of the old lease is refused by the new home for good
  assert.equal(b.home.current({ homeId: A.homeId, leaseEpoch: 1 }), false);
  assert.equal(b.home.current(b.home.stamp()), true);
  // the old home answers a repeated finish as it is
  assert.equal(
    (await a.side.call('finish', { moveId: 'move-0001', leaseEpoch: 2, name: B.name, homeId: B.homeId, receipt: r.receipt })).home.state,
    'none',
  );
  assert.equal(
    await finishOld({ moveId: 'move-0001', from: a.side, leaseEpoch: 2, name: B.name, homeId: B.homeId, receipt: r.receipt }),
    'cleared',
  );
});

test('Cancel before the switch, at each step: the old home runs again at the same epoch, with its data, and the target holds nothing', async (t) => {
  for (const at of [1, 2, 3]) {
    const a = await studio(t);
    const b = await host(t, B);
    let calls = 0;
    const r = await run(a, b, { cancelled: () => ++calls === at });
    assert.deepEqual(
      [r.ok, r.step, r.code, r.rolledBack],
      [false, ['paused', 'sealed', 'copied'][at - 1], 'cancelled', true],
      `cancel ${at}`,
    );
    const h = a.home.status().home;
    assert.deepEqual([h.state, h.leaseEpoch, h.moveId, h.bundleHash], ['running', 1, null, null]);
    assert.deepEqual(
      a.home
        .stores()!
        .memory.list()
        .facts.map((f: any) => f.text),
      ['Lives in Berlin'],
    );
    assert.equal(b.home.status().home, null);
    assert.equal(fs.existsSync(`${b.momoDir}.incoming`), false);
    assert.equal(fs.existsSync(`${b.dataKeyDir}.incoming`), false);
    // and the target may be offered another move
    assert.equal((await b.side.call('offer', { moveId: 'move-0002' })).moveId, 'move-0002');
  }
});

test('the steps refuse what is out of order, and a second move is "Another move started"', async (t) => {
  const a = await studio(t);
  const b = await host(t, B);
  const stranger = await host(t, { homeId: 'home-cccc-3333', name: 'Laptop' });
  await assert.rejects(stranger.side.call('begin', { moveId: 'move-0001' }), (e: any) => e.code === 'home_not_here');
  await assert.rejects(a.side.call('seal', { moveId: 'move-0001', targetKey: 'x' }), (e: any) => e.code === 'move_unknown');
  assert.equal((await a.side.call('cancel', { moveId: 'move-0001' })).home.state, 'running', 'a cancel with nothing to cancel is a no-op');
  await assert.rejects(
    a.side.call('finish', { moveId: 'move-0001', leaseEpoch: 2, name: B.name, homeId: B.homeId }),
    (e: any) => e.code === 'move_unknown',
  );
  assert.equal((await a.side.call('begin', { moveId: 'move-0001' })).home.state, 'moving');
  assert.equal((await a.side.call('begin', { moveId: 'move-0001' })).home.state, 'moving', 'the same move again is the same move');
  await assert.rejects(
    a.side.call('begin', { moveId: 'move-0002' }),
    (e: any) => e.code === 'move_in_progress' && /Another move started/.test(e.message),
  );
  // the move of another id is refused by the app's orchestrator without touching the running one
  const r = await run(a, b, { moveId: 'move-0002' });
  assert.deepEqual(
    [r.ok, r.step, r.code, r.rolledBack],
    [false, 'paused', 'move_in_progress', true],
    'only the target’s offer is given up',
  );
  assert.equal(a.home.status().home.moveId, 'move-0001');
  // a finish that is not a newer lease is refused
  await assert.rejects(
    a.side.call('finish', { moveId: 'move-0001', leaseEpoch: 1, name: B.name, homeId: B.homeId }),
    (e: any) => e.code === 'home_lease_stale',
  );
  // the new home's steps
  await assert.rejects(
    b.side.call('receive', { moveId: 'move-0001', sealed: 'x', bundleHash: 'y' }),
    (e: any) => e.code === 'move_unknown',
  );
  await assert.rejects(
    b.side.call('commit', { moveId: 'move-0001', leaseEpoch: 2, homeId: B.homeId, name: B.name, from: A.name }),
    (e: any) => e.code === 'move_unknown',
  );
  assert.deepEqual(await b.side.call('discard', { moveId: 'move-0001' }), { discarded: true, proof: null });
  // a home is not a target
  await assert.rejects(a.side.call('offer', { moveId: 'move-0003' }), (e: any) => e.code === 'home_exists');
  fs.mkdirSync(b.momoDir, { recursive: true });
  fs.writeFileSync(path.join(b.momoDir, 'memory.json'), 'x');
  // MoMo data on a machine that is no home is what a cut-short switch left: the offer clears it (a retry must be possible)
  assert.ok(await b.side.call('offer', { moveId: 'move-0003' }));
  assert.equal(fs.existsSync(path.join(b.momoDir, 'memory.json')), false);
  // the target's own files do not count as data
  fs.writeFileSync(path.join(b.momoDir, 'chats.json'), 'x');
  assert.ok(await b.side.call('offer', { moveId: 'move-0003' }));
});

test('a bundle that was changed, made for another move or another machine, names a path outside the folder, or whose audit chain is broken is refused, and the old home runs again', async (t) => {
  // a bundle opened by another machine's key
  {
    const a = await studio(t);
    const b = await host(t, B);
    const wrong = newMoveKey();
    const side = {
      ...b.side,
      call: async (op: string, p: any) =>
        op === 'offer' ? { ...(await b.side.call(op, p)), targetKey: wrong.publicKey } : b.side.call(op, p),
    };
    const r = await run(a, { side });
    assert.deepEqual([r.ok, r.step, r.code, r.rolledBack], [false, 'copied', 'bundle_unreadable', true]);
    assert.equal(a.home.status().home.state, 'running');
  }
  // a bundle whose hash is not the one sealed
  {
    const a = await studio(t);
    const b = await host(t, B);
    const side = {
      ...a.side,
      call: async (op: string, p: any) =>
        op === 'seal' ? { ...(await a.side.call(op, p)), bundleHash: 'f'.repeat(64) } : a.side.call(op, p),
    };
    const r = await run({ side }, b);
    assert.deepEqual([r.ok, r.code, r.rolledBack], [false, 'bundle_mismatch', true]);
    assert.equal(a.home.status().home.state, 'running');
  }
  // a path out of the folder
  {
    const b = await host(t, B);
    const offer = await b.side.call('offer', { moveId: 'move-0001' });
    const evil = sealBundle({
      moveId: 'move-0001',
      files: [{ path: '../evil', data: Buffer.from('x') }],
      dataKey: Buffer.alloc(32, 1),
      targetKey: offer.targetKey,
    });
    await assert.rejects(
      b.side.call('receive', { moveId: 'move-0001', sealed: evil.sealed, bundleHash: evil.hash }),
      (e: any) => e.code === 'bundle_unreadable' && /outside/.test(e.message),
    );
    assert.equal(fs.existsSync(path.join(b.dir, 'data', 'evil')), false);
  }
  // an audit log cut or changed on the way
  {
    const a = await studio(t);
    const b = await host(t, B);
    const real = a.side;
    const side = {
      ...real,
      call: async (op: string, p: any) => {
        if (op !== 'seal') return real.call(op, p);
        const auditDir = path.join(a.momoDir, 'audit');
        for (const f of fs.readdirSync(auditDir).filter((n) => n.endsWith('.jsonl')))
          fs.writeFileSync(path.join(auditDir, f), fs.readFileSync(path.join(auditDir, f), 'utf8').replace(/"mac":"[0-9a-f]/, '"mac":"z'));
        return real.call(op, p);
      },
    };
    const r = await run({ side, status: real.status }, b);
    assert.deepEqual([r.ok, r.step, r.code], [false, 'copied', 'audit_chain_broken']);
    assert.equal(fs.existsSync(`${b.momoDir}.incoming`), false, 'nothing is left behind');
    assert.equal(b.home.status().home, null);
  }
});

test('a bundle too large for one frame is refused by the old home before anything leaves it; a home with no movable key is unavailable', async (t) => {
  const a = await studio(t);
  const b = await host(t, B);
  await a.side.call('begin', { moveId: 'move-0001' });
  const offer = await b.side.call('offer', { moveId: 'move-0001' });
  fs.writeFileSync(path.join(a.momoDir, 'big.bin'), crypto_bytes(MAX_BUNDLE_BYTES));
  await assert.rejects(
    a.side.call('seal', { moveId: 'move-0001', targetKey: offer.targetKey, signKey: offer.signKey }),
    (e: any) => e.code === 'bundle_too_large',
  );
  fs.rmSync(path.join(a.momoDir, 'big.bin'));
  // a home whose data key is not a file of its own cannot seal one
  const loose = await host(t, A);
  const plain: any = createMomoHome({
    hostId: 'home-aaaa-1111',
    dataDir: path.join(loose.dir, 'plain'),
    safeStorage: createFileSafeStorage(path.join(loose.dir, 'plain-config')),
  });
  plain.move = createMomoMove({ home: plain });
  await plain.grant({ account: 'a1', features: MOMO });
  await plain.start(A);
  await plain.move.begin({ moveId: 'move-0009' });
  await assert.rejects(
    plain.move.seal({ moveId: 'move-0009', targetKey: offer.targetKey, signKey: offer.signKey }),
    (e: any) => e.code === 'move_unavailable',
  );
  await plain.close();
});
function crypto_bytes(n: number) {
  return Buffer.alloc(n, 7);
}

test('the switch is confirmed with the target, never guessed: a commit whose answer was lost but that happened goes on; one that did not happen rolls back; one that cannot be asked leaves the move uncertain', async (t) => {
  // answer lost after the target switched
  {
    const a = await studio(t);
    const b = await host(t, B);
    const lost = {
      ...b.side,
      call: async (op: string, p: any) => {
        const out = await b.side.call(op, p);
        if (op === 'commit') throw new Error('socket closed');
        return out;
      },
    };
    const lostR = await run(a, lost);
    assert.deepEqual(
      [lostR.ok, lostR.oldHome, lostR.leaseEpoch],
      [true, 'cleared', 2],
      'the target is asked, says it switched, and the move goes on',
    );
    assert.equal(b.home.status().home.state, 'running');
  }
  // the target refused: not switched, so back
  {
    const a = await studio(t);
    const b = await host(t, B);
    const refusing = {
      ...b.side,
      call: async (op: string, p: any) => {
        if (op === 'commit') throw Object.assign(new Error('no'), { code: 'home_exists' });
        return b.side.call(op, p);
      },
    };
    const r = await run(a, refusing);
    assert.deepEqual([r.ok, r.step, r.code, r.rolledBack, (r as any).uncertain], [false, 'switching', 'home_exists', true, undefined]);
    assert.equal(a.home.status().home.state, 'running');
  }
  // the target cannot be reached at all: nobody runs, and it says so
  {
    const a = await studio(t);
    const b = await host(t, B);
    const dark = {
      call: async (op: string, p: any) => {
        if (op === 'commit') throw Object.assign(new Error('timed out'), { code: 'timeout' });
        if (op === 'discard') throw new Error('down');
        return b.side.call(op, p);
      },
    };
    const r: any = await run(a, dark);
    assert.deepEqual([r.ok, r.step, r.code, r.rolledBack, r.uncertain], [false, 'switching', 'timeout', false, true]);
    assert.equal(a.home.status().home.state, 'moving', 'the old home does not run again on a guess');
  }
  // an error that is not a Host's refusal still reads as a failure with words
  {
    const a = await studio(t);
    const b = await host(t, B);
    const odd = {
      ...b.side,
      call: async (op: string, p: any) => {
        if (op === 'receive') throw 'broken';
        return b.side.call(op, p);
      },
    };
    const r: any = await run(a, odd);
    assert.deepEqual([r.ok, r.code, r.message], [false, 'failed', 'It did not finish.']);
  }
});

test('the old machine is offline at the end: the move still finishes on the new home, says the old one holds a copy, and clears it when it is back', async (t) => {
  const a = await studio(t);
  const b = await host(t, B);
  let up = true;
  const flaky = {
    ...a.side,
    call: async (op: string, p: any) => {
      if (op === 'finish' && !up) throw new Error('offline');
      return a.side.call(op, p);
    },
  };
  const r: any = await moveHome({
    moveId: 'move-0001',
    from: { ...flaky, status: a.side.status },
    to: b.side,
    target: B,
    fromName: A.name,
    step: (s: string) => {
      if (s === 'cleaning-up') up = false;
    },
  });
  assert.deepEqual([r.ok, r.oldHome, r.leaseEpoch, typeof r.receipt], [true, 'offline', 2, 'string']);
  assert.equal(a.home.status().home.state, 'moving', 'it still holds its copy, and takes no turns');
  assert.equal(a.home.stamp(), null);
  up = true;
  assert.equal(
    await finishOld({ moveId: 'move-0001', from: flaky, leaseEpoch: 2, name: B.name, homeId: B.homeId, receipt: r.receipt }),
    'cleared',
  );
  assert.equal(a.home.status().home.state, 'none');
});

test('the bundle: only the machine whose key it was made for opens it, the move id is bound into it, paths are checked, and the files and key come out as they went in', () => {
  const k = newMoveKey();
  assert.match(k.fingerprint, /^[0-9A-F]{4}-[0-9A-F]{4}$/);
  const files = [
    { path: 'audit/a.jsonl', data: Buffer.from('line\n') },
    { path: 'turns.json', data: Buffer.from('{}') },
  ];
  const b = sealBundle({ moveId: 'move-0001', files, dataKey: Buffer.alloc(32, 9), targetKey: k.publicKey });
  const out = openBundle({ moveId: 'move-0001', sealed: b.sealed, privateKey: k.privateKey });
  assert.deepEqual(
    out.files.map((f: any) => [f.path, f.data.toString()]),
    [
      ['audit/a.jsonl', 'line\n'],
      ['turns.json', '{}'],
    ],
  );
  assert.deepEqual([out.dataKey.equals(Buffer.alloc(32, 9)), out.hash], [true, b.hash]);
  assert.throws(() => openBundle({ moveId: 'move-0002', sealed: b.sealed, privateKey: k.privateKey }));
  assert.throws(() => openBundle({ moveId: 'move-0001', sealed: b.sealed, privateKey: newMoveKey().privateKey }));
  assert.throws(
    () => openBundle({ moveId: 'move-0001', sealed: Buffer.alloc(10).toString('base64'), privateKey: k.privateKey }),
    /not complete/,
  );
  assert.throws(() => sealBundle({ moveId: 'move-0001', files, dataKey: Buffer.alloc(32), targetKey: 'AAAA' }), /not a move key/);
  // a well-sealed bundle that is not a bundle, or that carries no usable key
  for (const inner of [
    { v: 2 },
    { v: 1, moveId: 'other', files: [], dataKey: 'x' },
    { v: 1, moveId: 'move-0001', files: [], dataKey: Buffer.alloc(3).toString('base64') },
  ]) {
    const odd = sealRaw('move-0001', JSON.stringify(inner), k.publicKey);
    assert.throws(() => openBundle({ moveId: 'move-0001', sealed: odd, privateKey: k.privateKey }), /not one of this move|no usable key/);
  }
  assert.deepEqual(['a', 'a/b.json', '.x/y'].map(safeRel), [true, true, true]);
  assert.deepEqual(['', '/abs', '../x', 'a/../b', 'a//b', 'a\\b', './a'].map(safeRel), [false, false, false, false, false, false, false]);
  assert.deepEqual(
    collectFiles(path.join(os.tmpdir(), 'momo-move-does-not-exist'), () => false),
    [],
  );
});
/** Seals `text` as sealBundle does, to test what openBundle makes of a bundle that is well sealed but wrong inside. */
import crypto from 'node:crypto';
function sealRaw(moveId: string, text: string, targetKey: string) {
  const SPKI = Buffer.from('302a300506032b656e032100', 'hex');
  const peer = crypto.createPublicKey({ key: Buffer.concat([SPKI, Buffer.from(targetKey, 'base64')]), format: 'der', type: 'spki' });
  const eph = crypto.generateKeyPairSync('x25519');
  const shared = crypto.diffieHellman({ privateKey: eph.privateKey, publicKey: peer });
  const key = Buffer.from(crypto.hkdfSync('sha256', shared, Buffer.from(moveId), Buffer.from('mopilot momo move v1'), 32));
  const nonce = crypto.randomBytes(12);
  const c = crypto.createCipheriv('chacha20-poly1305', key, nonce, { authTagLength: 16 });
  c.setAAD(Buffer.from(moveId));
  const body = Buffer.concat([c.update(text, 'utf8'), c.final()]);
  const raw = (eph.publicKey.export({ format: 'der', type: 'spki' }) as Buffer).subarray(SPKI.length);
  return Buffer.concat([raw, nonce, c.getAuthTag(), body]).toString('base64');
}

test('on the wire: host.momoMove is unknown to an unpaired client, its steps are checked before they run, and a granted client drives a move across two served Hosts', async (t) => {
  const a = await studio(t);
  const b = await host(t, B);
  const hostA = await servedHost(t, { momo: a.home });
  const hostB = await servedHost(t, { momo: b.home });
  const stranger = hostA.line();
  const asked = await stranger.call('host.momoMove', { op: 'begin', moveId: 'move-0001' });
  assert.match(JSON.stringify(asked), /Unknown request/);
  const clientA = (await hostA.paired('mac', 'Mac')).conn;
  const clientB = (await hostB.paired('mac', 'Mac')).conn;
  for (const c of [clientA, clientB]) await c.request('host.momoGrant', { account: 'a1', features: MOMO });
  for (const c of [clientA, clientB]) await c.call('host.hello', helloParams());
  // bad steps never reach the Host
  const bad: [object, RegExp][] = [
    [{ op: 'zzz', moveId: 'move-0001' }, /not a step/],
    [{ op: 'begin', moveId: 'x' }, /not a move id/],
    [{ op: 'seal', moveId: 'move-0001', targetKey: '', signKey: 's' }, /not a move key/],
    [{ op: 'receive', moveId: 'move-0001', sealed: 'x', bundleHash: 'nope' }, /not a bundle hash/],
    [{ op: 'finish', moveId: 'move-0001', leaseEpoch: 0, name: 'x', homeId: 'home-aaaa-1111', receipt: 'r' }, /not a lease epoch/],
    [{ op: 'finish', moveId: 'move-0001', leaseEpoch: 2, name: 'x', homeId: 'home-aaaa-1111' }, /not a receipt/],
    [{ op: 'seal', moveId: 'move-0001', targetKey: 'k' }, /not a signing key/],
    [{ op: 'cancel', moveId: 'move-0001', proof: '' }, /not a proof/],
    [{ op: 'finish', moveId: 'move-0001', leaseEpoch: 2, name: 'x', homeId: 'no', receipt: 'r' }, /not a home id/],
  ];
  for (const [p, re] of bad) await assert.rejects(clientA.request('host.momoMove', p), re);
  // a whole move, each step over a wire
  const wire = (c: any) => ({
    call: (op: string, p: object = {}) => c.request('host.momoMove', { op, ...p }),
    status: () => c.request('host.momoStatus'),
  });
  const r: any = await moveHome({ moveId: 'move-0001', from: wire(clientA), to: wire(clientB), target: B, fromName: A.name });
  assert.deepEqual([r.ok, r.oldHome, r.leaseEpoch], [true, 'cleared', 2]);
  assert.equal((await clientB.request('host.momoStatus')).home.state, 'running');
  assert.equal((await clientA.request('host.momoStatus')).home.movedTo.name, B.name, 'the old machine says where MoMo went');
});

test('the serve entry gives the home its own data key, so a move can carry it, and a move object', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'momo-move-wiring-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const paths = { dataDir: path.join(dir, 'data'), configDir: path.join(dir, 'config') };
  const sessions: any = { chats: { records: new Map(), patchMeta: () => undefined }, isolated: () => true, isolate: () => undefined };
  const home: any = momoHomeFor({
    hostId: 'home-aaaa-1111',
    paths,
    report: () => undefined,
    sessions,
    epochs: { current: () => 0 },
    hidden: createMomoHidden(),
  });
  assert.equal(typeof home.move.begin, 'function');
  await home.grant({ account: 'a1', features: MOMO });
  await home.start(A);
  await home
    .stores()
    .memory.save({ text: 'x', source: { chatId: 'momo-chat', harness: 'claude' } })
    .catch(() => undefined);
  await home.stores().turns.accept({ turnId: 'key-00000001', chatId: 'claude:c1', deviceId: null, leaseEpoch: 1 });
  assert.ok(fs.existsSync(path.join(paths.configDir, 'momo', 'safe-storage.key')), 'MoMo’s stores have a key file of their own');
  assert.ok(fs.existsSync(path.join(paths.configDir, 'safe-storage.key')), 'and the Host’s own key still seals the home record');
  await home.close();
});
