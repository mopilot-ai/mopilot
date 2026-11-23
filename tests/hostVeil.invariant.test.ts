// Whole-repository invariant for the veil (host/src/methodHandlers.mjs): a Host method the server's pairing gate does not answer (access 'open') is veiled by its own file, so no unpaired client reaches a handler; a host.momo* method is always one of them; and the veil answers every way it can be asked wrongly (no principal, odd names, a veil or a grant check that throws) as a request no Host knows.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { codeFilesIn, collectMethodFiles, defaultOf } from '../shared/host/methodFiles.mjs';
import { createProtocol } from '../host/src/protocol.mjs';
import { createEpochStore } from '../host/src/epochs.mjs';
import { createLedger } from '../host/src/ledger.mjs';
import { createGuard } from '../host/src/guard.mjs';
import { helloParams } from '../shared/host/schema.mjs';

export const GUARDS = ['host/src/methods/', 'shared/host/methods/'];

const req = createRequire(import.meta.url);
const root = path.join(import.meta.dirname, '..');
const hostDir = path.join(root, 'host', 'src', 'methods');
const sharedDir = path.join(root, 'shared', 'host', 'methods');
const kit = new Proxy(
  {},
  {
    get:
      () =>
      (...a: unknown[]) =>
        a[0],
  },
);

/** Every method of the folder's files: where it is declared, whether the server's pairing gate answers it, and whether its host file veils it. */
function methods() {
  return codeFilesIn(hostDir).flatMap((name) => {
    const declared = collectMethodFiles(
      [name],
      (n) => req(path.join(sharedDir, n)),
      kit,
      () => false,
    );
    const veils = Object.keys(defaultOf(req(path.join(hostDir, name)))({}).veils ?? {});
    return Object.keys(declared.parsers).map((method) => ({
      name,
      method,
      open: !declared.paired.includes(method),
      veiled: veils.includes(method),
    }));
  });
}

test('every open method of a feature file is veiled by its host file, and every host.momo* method is both', () => {
  const all = methods();
  assert.ok(
    all.some((m) => m.method.startsWith('host.momo')) && all.some((m) => m.method === 'host.relayStatus'),
    'the scan found the folder',
  );
  for (const m of all) {
    if (m.open) assert.ok(m.veiled, `${m.method} is open to the pairing gate but has no veil in methods/${m.name}`);
    if (m.method.startsWith('host.momo'))
      assert.ok(m.open && m.veiled, `${m.method} must be open and veiled: the veil is what answers an unpaired client`);
  }
});

test('a veiled method is a request no Host knows to any caller without a principal, under any spelling, and when a check throws', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'veil-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const quiet = { report: () => undefined };
  const epochs = createEpochStore(path.join(dir, 'e.json'), quiet);
  const guard = createGuard({ epochs, ledger: createLedger(path.join(dir, 'l'), quiet) });
  const runtime: any = { host: Object.assign(new EventEmitter(), { cancel: () => undefined }) };
  const reached: string[] = [];
  const home: any = {
    granted: () => true,
    status: () => (reached.push('status'), {}),
    grant: () => (reached.push('grant'), {}),
    start: () => (reached.push('start'), {}),
  };
  const reports: string[] = [];
  const open = async (momo: any, principal: unknown, report?: (m: string) => void) => {
    const conn = createProtocol({ runtime, epochs, guard, status: () => ({}), momo, ...(report ? { report } : {}) }).connection(
      () => undefined,
      () => null,
      { principal: () => principal as any },
    );
    await conn.call('host.hello', helloParams());
    return (method: string, params: unknown = { account: 'a1', features: ['momo'], homeId: 'home-aaaa-1111', name: 'x' }) =>
      conn.call(method, params).then(
        () => 'answered',
        (e: any) => `${e.code}:${e.message}`,
      );
  };
  const veiled = methods()
    .filter((m) => m.open && m.veiled)
    .map((m) => m.method);
  assert.ok(veiled.includes('host.momoStatus'));
  const answers = async (call: (m: string, p?: unknown) => Promise<string>, method: string) => call(method);
  const unknownOf = async (call: (m: string, p?: unknown) => Promise<string>, method: string) =>
    (await call('host.zzz')).replace('host.zzz', method);
  // no principal of any falsy kind: every veiled method answers as unknown and no handler runs
  for (const principal of [null, undefined, 0, '', false]) {
    const call = await open(home, principal);
    for (const method of veiled)
      assert.equal(await answers(call, method), await unknownOf(call, method), `${method} for ${String(principal)}`);
  }
  // other spellings and names the object prototype has are not veiled methods, and not known ones either
  const call = await open(home, null);
  for (const name of [
    'Host.momoStatus',
    'host.momostatus',
    ' host.momoStatus',
    'host.momoStatus ',
    'host.momoStatus\0',
    '__proto__',
    'constructor',
    'toString',
    'hasOwnProperty',
  ])
    assert.equal(await call(name), await unknownOf(call, name), name);
  assert.deepEqual(reached, [], 'no handler ran for any of them');
  // a grant check that throws, or a veil with nothing to ask: the unknown answer, and the Host's own report says why
  const failing = {
    ...home,
    granted: () => {
      throw new Error('keychain locked');
    },
  };
  const throwing = await open(failing, {}, (m) => reports.push(m));
  assert.equal(await throwing('host.momoStatus'), await unknownOf(throwing, 'host.momoStatus'));
  assert.match(reports.join(), /veil failed for host.momoStatus: keychain locked/);
  const silent = await open(failing, {});
  assert.equal(await silent('host.momoStatus'), await unknownOf(silent, 'host.momoStatus'));
  const odd = await open(
    {
      ...home,
      granted: () => {
        throw 'plain';
      },
    },
    {},
    (m) => reports.push(m),
  );
  assert.equal(await odd('host.momoStatus'), await unknownOf(odd, 'host.momoStatus'));
  assert.match(reports.join(), /veil failed for host.momoStatus: plain/);
});
