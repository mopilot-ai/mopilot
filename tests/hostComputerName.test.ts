// An added machine is named for the computer its Host reports (`host.status` `computerName`), not for the address typed (#4930): the install names it from the Host's first answer, each later answer renames a machine nobody renamed, a person's own name always wins (also across restarts and for machines saved before the field), an older Host that names nothing leaves the address name, and two machines with one name stay apart.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { useFakeClock } from './support/ports/clock.ts';
import { status, bundle, machine } from './support/host-install-kit.ts';
// @ts-ignore: plain ESM without declarations
import { hostStatus } from '../host/src/status.mjs';
import { computerNameOf, addressName } from '../shared/host/computerName.mjs';
import { cleanComputerName } from '../shared/remote/computerName.mjs';
const require = createRequire(import.meta.url);
const { createRegistry } = require('../electron/host/registry.cjs');
const { createMachines } = require('../electron/host/machines.cjs');
const { createInstaller } = require('../electron/host/install.cjs');
const L = require('../electron/host/localHost.cjs');

const ready = { harnesses: [{ id: 'claude', detected: true, signedIn: true }], capabilities: { shell: true } };
const fileOf = (t: any) => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'cname-'));
  t.after(() => fs.rmSync(d, { recursive: true, force: true }));
  return path.join(d, 'host-registry.json');
};
const ip = { id: 'ssh:daxhill@192.168.64.1', name: '192.168.64.1', address: 'daxhill@192.168.64.1' };
const make = (t: any, answer: () => unknown, file = fileOf(t)) => {
  useFakeClock(t, 1_000_000);
  const r = createRegistry({ file, status: async () => answer() });
  t.after(() => r.dispose());
  return { r, file };
};
const install = async (reply: object, destination = 'daxhill@192.168.64.1', script: Record<string, any> = {}) => {
  const added: any[] = [];
  const m = machine({ status: { stdout: JSON.stringify(reply) }, ...script });
  const out = await createInstaller({ channel: m.channel, registry: { add: (h: any) => added.push(h) }, bundle }).install(destination);
  return { out, added };
};

test('computerNameOf: the first label of a hostname, a spaced or numeric name whole, and nothing for what is not a name (B1, B3)', () => {
  assert.equal(computerNameOf('Dus-Mac-mini.local'), 'Dus-Mac-mini');
  assert.equal(computerNameOf(' box.example.com '), 'box');
  assert.equal(computerNameOf("Du's Mac mini"), "Du's Mac mini");
  assert.equal(computerNameOf('192.168.64.1'), '192.168.64.1');
  for (const bad of ['', '   ', '.', 'localhost', 'Localhost.localdomain', 'localhost.', 7, null, undefined, {}, ['a']])
    assert.equal(computerNameOf(bad), '', String(bad));
  assert.equal(computerNameOf('x'.repeat(64)), 'x'.repeat(64));
  assert.equal(computerNameOf('x'.repeat(65)), 'x'.repeat(64), 'cut to the limit, as the phone cuts it');
  // one validator with the phone's hello (shared/remote/computerName.mjs): what it hides, this hides, and what this returns it keeps
  assert.equal(computerNameOf('a\nb'), 'a b');
  assert.equal(computerNameOf('\u202Eevil\u200Bbox'), cleanComputerName('\u202Eevil\u200Bbox'));
  for (const v of ['Dus-Mac-mini.local', "Du's Mac mini", '\u202Eevil\u200Bbox', 'x'.repeat(90), 'a\tb']) {
    const n = computerNameOf(v);
    assert.equal(cleanComputerName(n), n, v);
    assert.doesNotMatch(n, /[\u0000-\u001f\u200b-\u200f\u202a-\u202e\u2066-\u2069]/);
  }
  assert.equal(addressName('daxhill@192.168.64.1'), '192.168.64.1');
  assert.equal(addressName('mac'), 'mac');
});

test('the Host reports its own computer name in its status, one valid label, and none when the system gives none (I4)', () => {
  assert.equal(hostStatus({ running: true, computerName: 'Dus-Mac-mini.local' }).computerName, 'Dus-Mac-mini');
  assert.equal(hostStatus({ running: true }).computerName, computerNameOf(os.hostname()) || undefined);
  assert.ok(!('computerName' in hostStatus({ running: true, computerName: '' })), 'an unusable name is left out, not sent empty');
});

test('a machine added by IP takes the computer name its Host reported at install, and keeps the typed address as its address', async () => {
  const { out, added } = await install({ ...status, computerName: 'mopilot-mini' });
  assert.equal(out.ok, true);
  assert.deepEqual([added[0].name, added[0].address], ['mopilot-mini', 'daxhill@192.168.64.1']);
});

test('an older Host that names nothing leaves the address name; this Mac keeps its own name and never adopts one (B3)', async () => {
  for (const reply of [status, { ...status, computerName: 7 }, { ...status, computerName: 'localhost' }])
    assert.equal((await install(reply)).added[0].name, '192.168.64.1');
  const { added } = await install({ ...status, computerName: 'mopilot-mini' }, L.localAddress('me'), {
    'uname -sm': { stdout: 'Darwin arm64\n' },
  });
  assert.deepEqual([added[0].name, added[0].renamed], [L.LOCAL_NAME, true]);
});

test('a machine nobody renamed follows the name its Host reports, at each answer, and the file keeps it (W3)', async (t) => {
  let said: unknown = { ...ready };
  const { r, file } = make(t, () => said);
  r.add(ip);
  await r.check();
  assert.equal(r.list()[0].name, '192.168.64.1', 'an older Host: the address name stays');
  said = { ...ready, computerName: 'mopilot-mini.local' };
  await r.check();
  assert.deepEqual(
    [r.list()[0].name, r.list()[0].computerName, r.list()[0].address],
    ['mopilot-mini', 'mopilot-mini', 'daxhill@192.168.64.1'],
  );
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).hosts[0].name, 'mopilot-mini');
  said = { ...ready, computerName: 'Studio' };
  await r.check();
  assert.equal(r.list()[0].name, 'Studio', 'the computer was renamed: the machine follows');
  said = { ...ready };
  await r.check();
  assert.equal(r.list()[0].name, 'Studio', 'a Host that stops saying a name does not undo the last one');
  for (const bad of ['', '\n', 'localhost', 9, null]) {
    said = { ...ready, computerName: bad };
    await r.check();
    assert.equal(r.list()[0].name, 'Studio', `ignored: ${String(bad)}`);
  }
});

test('a name the person gave wins over the computer name, now and after a restart (never overwritten)', async (t) => {
  let said: unknown = { ...ready, computerName: 'mopilot-mini' };
  const { r, file } = make(t, () => said);
  r.add(ip);
  await r.check();
  r.rename(ip.id, 'Mac mini (office)');
  said = { ...ready, computerName: 'something-else' };
  await r.check();
  assert.equal(r.list()[0].name, 'Mac mini (office)');
  const again = createRegistry({ file, status: async () => said });
  t.after(() => again.dispose());
  await again.check();
  assert.deepEqual([again.list()[0].name, again.list()[0].computerName], ['Mac mini (office)', 'something-else']);
});

test('a machine saved by an older app: a name that is just its address is replaced by the computer name, a name the person chose or a cloud machine has is not (I2)', async (t) => {
  const file = fileOf(t);
  const raw = (id: string, name: string, address: string) => ({
    id,
    name,
    address,
    kind: 'ssh',
    socketPath: '',
    capabilities: {},
    harnesses: [],
  });
  fs.writeFileSync(
    file,
    JSON.stringify({
      version: 1,
      hosts: [
        raw('a', '192.168.64.1', 'u@192.168.64.1'),
        raw('b', 'My laptop', 'u@10.0.0.5'),
        { ...raw('c', 'cloud-box', 'u@1.2.3.4'), cloud: { provider: 'oci', instance: 'x' } },
      ],
    }),
  );
  const { r } = make(t, () => ({ ...ready, computerName: 'mopilot-mini' }), file);
  assert.equal(r.list().length, 3);
  await r.check();
  const names = Object.fromEntries(r.list().map((h: any) => [h.id, h.name]));
  assert.equal(names.a, 'mopilot-mini');
  assert.equal(names.b, 'My laptop');
  assert.equal(names.c, 'cloud-box');
});

test('a rename that lands while an answer is out is not overwritten by that answer (A3)', async (t) => {
  let answer: (v: unknown) => void = () => undefined;
  useFakeClock(t, 1_000_000);
  const r = createRegistry({ file: fileOf(t), status: () => new Promise((res) => (answer = res)) });
  t.after(() => r.dispose());
  r.add(ip);
  const first = r.check();
  r.rename(ip.id, 'Mine');
  answer({ ...ready, computerName: 'mopilot-mini' });
  await first;
  assert.equal(r.list()[0].name, 'Mine');
});

test('two machines that report one name stay apart: the address tells them, the full address when the host part is the same too (I1)', async (t) => {
  const { r } = make(t, () => ({ ...ready, computerName: 'mopilot-mini' }));
  r.add(ip);
  r.add({ id: 'ssh:u@10.0.0.2', name: '10.0.0.2', address: 'u@10.0.0.2' });
  await r.check();
  assert.deepEqual(
    r.list().map((h: any) => h.name),
    ['mopilot-mini (192.168.64.1)', 'mopilot-mini (10.0.0.2)'],
  );
  r.add({ id: 'ssh:other@192.168.64.1', name: '192.168.64.1', address: 'other@192.168.64.1' });
  await r.check();
  assert.deepEqual(
    r.list().map((h: any) => h.name),
    ['mopilot-mini (daxhill@192.168.64.1)', 'mopilot-mini (10.0.0.2)', 'mopilot-mini (other@192.168.64.1)'],
  );
  r.remove('ssh:other@192.168.64.1');
  r.remove('ssh:u@10.0.0.2');
  assert.equal(r.list()[0].name, 'mopilot-mini', 'alone again: the plain name');
});

test('every surface reads the same name: the machines list shows the registry name, and a rename shows there (I4)', async (t) => {
  const file = fileOf(t);
  useFakeClock(t, 1_000_000);
  const call = async () => ({ ...ready, computerName: 'mopilot-mini' });
  const registry = createRegistry({ file, status: call });
  const dir = path.dirname(file);
  const m = createMachines({
    dir,
    root: dir,
    allowed: () => true,
    watch: () => () => undefined,
    call,
    installer: { install: async () => null },
    registry,
  });
  t.after(() => m.dispose());
  registry.add(ip);
  await registry.check();
  assert.deepEqual([m.list().machines[0].name, m.list().machines[0].rawName], ['mopilot-mini', 'mopilot-mini']);
  m.rename(ip.id, 'Office');
  assert.equal(m.list().machines[0].name, 'Office');
});

test('Rename shows the plain name and never bakes the collision suffix in; saving it unchanged changes nothing and the machine keeps following its computer', async (t) => {
  let said: unknown = { ...ready, computerName: 'mopilot-mini' };
  const { r, file } = make(t, () => said);
  r.add(ip);
  r.add({ id: 'ssh:u@10.0.0.2', name: '10.0.0.2', address: 'u@10.0.0.2' });
  await r.check();
  const [a] = r.list();
  assert.deepEqual([a.name, a.rawName], ['mopilot-mini (192.168.64.1)', 'mopilot-mini']);
  let changes = 0;
  r.onChange(() => changes++);
  r.rename(a.id, a.rawName);
  r.rename(a.id, a.name);
  assert.equal(changes, 0, 'unchanged: no write, no event');
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).hosts[0].renamed, false, 'no silent flip to a person-chosen name');
  said = { ...ready, computerName: 'Studio' };
  await r.check();
  assert.equal(r.list()[0].rawName, 'Studio', 'still follows the computer');
  r.rename(a.id, 'Mine');
  assert.deepEqual([r.list()[0].rawName, JSON.parse(fs.readFileSync(file, 'utf8')).hosts[0].renamed], ['Mine', true]);
  r.rename(a.id, r.list()[0].name);
  assert.equal(r.list()[0].rawName, 'Mine');
});

test('adding a machine that is already there keeps the name the person gave it (re-add)', async (t) => {
  const { r } = make(t, () => ({ ...ready, computerName: 'mopilot-mini' }));
  r.add(ip);
  r.rename(ip.id, 'Office');
  r.add({ ...ip, name: 'mopilot-mini' });
  assert.deepEqual([r.list()[0].name, r.list()[0].renamed], ['Office', true]);
  r.remove(ip.id);
  r.add(ip);
  await r.check();
  r.add({ ...ip, name: 'other' });
  assert.equal(r.list()[0].name, 'other', 'an unrenamed machine takes the new add');
});

test('a machine joined through the relay is told apart by a short id, not its whole address', async (t) => {
  const { r } = make(t, () => ({ ...ready, computerName: 'MacBook-Pro' }));
  r.add({ id: 'relay:3f9a1c0d77e24b5aa1', name: 'x', address: 'relay:3f9a1c0d77e24b5aa1' });
  r.add({ id: 'relay:aa00bb11cc22dd33ee', name: 'y', address: 'relay:aa00bb11cc22dd33ee' });
  await r.check();
  assert.deepEqual(
    r.list().map((h: any) => h.name),
    ['MacBook-Pro (relay:3f9a1c)', 'MacBook-Pro (relay:aa00bb)'],
  );
});
