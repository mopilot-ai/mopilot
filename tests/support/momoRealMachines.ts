// The app's real machines service (electron/host/machines.cjs, with its real registry) with fake machines behind it: what MoMo's home sees is the real `list()` (`{ machines, resolved }` with the rows the service really gives) and the real registry row, never rows a test made up. A machine answers the heartbeat with what `answers` holds, and a paired session with what `host` says to each Host method.
// @ts-ignore
import { helloParams } from '../../shared/host/schema.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { useFakeClock as installFakeClock } from './ports/clock.ts';
import { createMachines } from './hostKeySafe.ts';

const require = createRequire(import.meta.url);
const { createRegistry } = require('../../electron/host/registry.cjs');

export type Seen = { id: string; method: string; params: any };

/** One machine of the app's list: its address and what its Host last said when the app asked it how it is. */
export type FakeMachine = { id: string; name: string; hostId?: string; build?: string; up?: boolean; harnesses?: object[] };

export function realMachines(t: any, fakes: FakeMachine[], host: (id: string, method: string, params: any) => Promise<any>) {
  const clock = installFakeClock(t, 1_000_000);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'momo-real-machines-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const byId = new Map(fakes.map((f) => [f.id, f]));
  const seen: Seen[] = [];
  const open: { id: string; closed: boolean }[] = [];
  const call = async (record: any, method: string) => {
    const f = byId.get(record.id);
    if (method !== 'status' || !f || f.up === false) throw new Error('Could not reach the machine.');
    return {
      harnesses: f.harnesses ?? [{ id: 'claude', detected: true, signedIn: true }],
      capabilities: { shell: true },
      build: f.build ?? 'b1',
    };
  };
  const registry = createRegistry({ file: path.join(dir, 'host-registry.json'), status: (r: any) => call(r, 'status') });
  const m = createMachines({
    dir,
    root: dir,
    allowed: () => true,
    watch: () => () => undefined,
    call,
    onChange: () => undefined,
    onStep: () => undefined,
    installer: { install: async () => ({ ok: false }) },
    registry,
    session: async (record: any) => {
      const mine = { id: record.id, closed: false };
      open.push(mine);
      let hello = false;
      return {
        call: async (method: string, params: any) => {
          seen.push({ id: record.id, method, params });
          // a Host that agrees to everything this build offers; every other request of the protocol is refused until the hello (as a real Host does)
          if (method === 'host.hello') return (hello = true), helloParams();
          if (!hello)
            throw Object.assign(new Error('Say hello first: the host and the app have not agreed on a version yet.'), {
              code: 'hello_required',
            });
          return host(record.id, method, params);
        },
        close: () => void (mine.closed = true),
      };
    },
  });
  t.after(() => m.dispose());
  for (const f of fakes) {
    registry.add({ id: f.id, name: f.name, address: `me@${f.id}`, socketPath: '/h/host.sock' });
    if (f.hostId) registry.pin(f.id, f.hostId);
  }
  const tick = () => new Promise((r) => setImmediate(r));
  return {
    m,
    registry,
    clock,
    seen,
    open,
    byId,
    /** The heartbeat of every machine, once: those that are up answer, the rest do not. */
    async beat() {
      clock.advance(30_000);
      await tick();
      await tick();
    },
  };
}
