// A machine's path (electron/host/pathTunnel.cjs): auto prefers SSH and uses the relay when only it is up, never moves a connection
// that is up, tells a switch as connecting then online; `ssh` never touches the relay and says SSH's own failure; `relay` never
// touches SSH; a lease's socket follows the path in use; enrolling or pinning while held takes effect without a new tunnel.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createPathTunnel } = require('../electron/host/pathTunnel.cjs');

type S = 'online' | 'connecting' | 'offline';
function fake(name: string, latencyMs: number | null = null) {
  const fns = new Set<(s: S, why: string) => void>();
  const t: any = {
    localSocket: `/sock/${name}`,
    state: 'offline' as S,
    reason: `${name} is down`,
    leases: 0,
    failed: [] as string[],
    latencyMs,
    onState: (fn: any) => (fns.add(fn), () => fns.delete(fn)),
    acquire() {
      t.leases++;
      let done = false;
      return { socketPath: t.localSocket, ready: Promise.resolve(true), release: () => (done ? undefined : ((done = true), t.leases--)) };
    },
    fail: (why: string) => t.failed.push(why),
    set(s: S, why = '') {
      t.state = s;
      t.reason = why;
      for (const fn of [...fns]) fn(s, why);
    },
  };
  return t;
}

test('auto: SSH first, the relay when only it is up, no move of a live path, and a switch told as connecting then online', async () => {
  const ssh = fake('ssh');
  const relay = fake('relay', 42);
  const p = createPathTunnel({ ssh, relay: () => relay });
  const seen: string[] = [];
  p.onState((s: S) => seen.push(s));
  assert.equal(p.state, 'offline');
  const lease = p.acquire();
  assert.equal(ssh.leases, 1);
  assert.equal(relay.leases, 1, 'both paths are held');
  assert.match(p.reason, /SSH: ssh is down · Relay: relay is down/);
  relay.set('connecting');
  assert.equal(p.state, 'connecting');
  relay.set('online');
  assert.equal(await lease.ready, true);
  assert.equal(p.path, 'relay');
  assert.equal(p.latencyMs, 42);
  assert.equal(lease.socketPath, '/sock/relay');
  // SSH comes up: the live relay connection is not moved
  ssh.set('online');
  assert.equal(p.path, 'relay');
  // the relay goes: SSH takes over, told as a switch
  seen.length = 0;
  relay.set('offline', 'gone');
  assert.deepEqual(seen, ['connecting', 'online']);
  assert.equal(p.path, 'ssh');
  assert.equal(p.latencyMs, null);
  assert.equal(lease.socketPath, '/sock/ssh');
  p.fail('bad frame');
  assert.deepEqual(ssh.failed, ['bad frame']);
  // a second lease of an online path is ready at once; the paths go when the last one is released
  const two = p.acquire();
  assert.equal(await two.ready, true);
  two.release();
  two.release();
  assert.equal(ssh.leases, 1);
  lease.release();
  assert.equal(ssh.leases, 0);
  assert.equal(relay.leases, 0);
  assert.equal(p.state, 'offline');
  assert.equal(p.path, null);
  assert.equal(p.leases, 0);
});

test('ssh: the relay is never used and SSH says why it failed; relay: SSH is never used', async () => {
  const ssh = fake('ssh');
  const relay = fake('relay');
  relay.set('online');
  let mode = 'ssh';
  const p = createPathTunnel({ ssh, relay: () => relay, mode: () => mode });
  const lease = p.acquire();
  assert.equal(relay.leases, 0, 'not even held');
  assert.equal(p.state, 'offline');
  assert.equal(p.reason, 'ssh is down');
  assert.equal(p.localSocket, '/sock/ssh');
  // pinned to the relay while held: SSH is let go and the relay is used
  mode = 'relay';
  p.sync();
  assert.equal(ssh.leases, 0);
  assert.equal(p.path, 'relay');
  // a relay path that went away (the machine was forgotten) leaves nothing to use
  const none = createPathTunnel({ ssh, relay: () => null, mode: () => 'relay' });
  none.acquire();
  assert.equal(none.reason, 'This machine has no relay path.');
  assert.equal(none.localSocket, '/sock/ssh');
  none.close();
  // close lets go of everything and settles waiting leases false
  const w = createPathTunnel({ ssh: fake('ssh2') });
  const waiting = w.acquire();
  w.close();
  assert.equal(await waiting.ready, false);
  lease.release();
});

test('a machine enrolled while its tunnel is held gains the relay path on sync; without one auto is SSH only', async () => {
  const ssh = fake('ssh');
  const relay = fake('relay');
  let enrolled: any = null;
  const p = createPathTunnel({ ssh, relay: () => enrolled });
  p.acquire();
  assert.equal(p.reason, 'ssh is down', 'one path names no path');
  enrolled = relay;
  p.sync();
  assert.equal(relay.leases, 1);
  relay.set('online');
  assert.equal(p.path, 'relay');
  assert.equal(p.latencyMs, null, 'not measured yet');
  // a path that stops being allowed while in use is left
  enrolled = null;
  p.sync();
  assert.equal(relay.leases, 0);
  assert.equal(p.state, 'offline');
});
