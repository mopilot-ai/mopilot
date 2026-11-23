// The Host's managed-policy file (host/src/managedPolicyFile.mjs, shared/managedPolicyReader.mjs, plan W2): read from this Host's path, refused when the Host's user can write it, last good kept, watched with a debounce.
import { test } from 'node:test';
import assert from 'node:assert/strict';
// @ts-ignore: plain ESM without declarations
import { createManagedFile } from '../host/src/managedPolicyFile.mjs';

const fakeFs = (content: string | null, uid = 0, mode = 0o100644) => {
  const state = { content, uid, mode, seen: [] as string[] };
  return {
    state,
    fs: {
      statSync: (f: string) => {
        state.seen.push(f);
        if (state.content === null) throw Object.assign(new Error('x'), { code: 'ENOENT' });
        return { uid: state.uid, mode: state.mode };
      },
      readFileSync: () => state.content,
      watch: () => ({ close() {} }),
    } as any,
  };
};

test('the Host reads its own path per platform', () => {
  const linux = fakeFs(null);
  createManagedFile({ platform: 'linux', fs: linux.fs });
  assert.deepEqual(linux.state.seen, ['/etc/mopilot-host/managed-policy.json']);
  const mac = fakeFs(null);
  createManagedFile({ platform: 'darwin', fs: mac.fs });
  assert.deepEqual(mac.state.seen, ['/Library/Application Support/MoPilot Host/managed-policy.json']);
});

test('a root-owned file is the policy; one the Host user can write is refused and reported, with the strict fallback', () => {
  const ok = fakeFs(JSON.stringify({ version: 1, organization: 'Acme', hosts: { roots: ['/srv/work'] } }));
  const file = createManagedFile({ platform: 'linux', fs: ok.fs });
  assert.equal(file.effectivePolicy().state, 'valid');
  assert.deepEqual(file.effectivePolicy().doc.hosts.roots, ['/srv/work']);
  const reported: string[] = [];
  const writable = fakeFs(JSON.stringify({ version: 1 }), 1000);
  const refused = createManagedFile({ platform: 'linux', fs: writable.fs, report: (m: string) => reported.push(m) });
  assert.equal(refused.effectivePolicy().state, 'fallback');
  assert.equal(refused.effectivePolicy().doc.permission.max, 'default');
  assert.equal(refused.effectivePolicy().doc.hosts.clients.phone, false);
  assert.match(reported[0], /not owned by root/);
});

test('W3: a corrupt rewrite keeps the last good policy', () => {
  const w = fakeFs(JSON.stringify({ version: 1, permission: { max: 'read-only' } }));
  const file = createManagedFile({ platform: 'linux', fs: w.fs });
  w.state.content = '{ broken';
  const p = file.reload();
  assert.equal(p.state, 'valid');
  assert.equal(p.doc.permission.max, 'read-only');
  assert.match(p.problem!, /not valid/);
});

test('A6: a burst of file events is one read after the debounce, on a mocked clock', () => {
  const w = fakeFs(JSON.stringify({ version: 1 }));
  let fire: () => void = () => undefined;
  w.fs.watch = (_d: string, _o: unknown, fn: () => void) => ((fire = fn), { close() {} });
  const timers: Array<{ fn: () => void; live: boolean }> = [];
  let reads = 0;
  const read = w.fs.readFileSync;
  w.fs.readFileSync = () => (reads++, read());
  const file = createManagedFile({
    platform: 'linux',
    fs: w.fs,
    debounceMs: 250,
    setTimer: (fn: () => void) => {
      const t = { fn, live: true };
      timers.push(t);
      return t;
    },
    clearTimer: (t: any) => {
      t.live = false;
    },
  });
  file.watch();
  const before = reads;
  w.state.content = JSON.stringify({ version: 1, permission: { max: 'default' } });
  fire();
  fire();
  fire();
  assert.equal(reads, before);
  assert.deepEqual(
    timers.map((t) => t.live),
    [false, false, true],
  );
  timers[2].fn();
  assert.equal(reads, before + 1);
  assert.equal(file.effectivePolicy().doc.permission.max, 'default');
});
