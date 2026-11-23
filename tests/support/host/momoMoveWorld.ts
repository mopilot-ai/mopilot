// Two Hosts' MoMo for the move and lifecycle tests: each its own data folder, Host key and MoMo data key, as `momoHomeFor` makes them.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
// @ts-ignore: plain ESM without declarations
import { createMomoHome } from '../../../host/src/momoHome.mjs';
// @ts-ignore
import { createMomoMove } from '../../../host/src/momoMove.mjs';
// @ts-ignore
import { createFileSafeStorage } from '../../../host/src/secretStore.mjs';
import { act } from '../momo-trust.ts';

export const MOMO = ['momo'];
export const A = { homeId: 'home-aaaa-1111', name: 'Studio' };
export const B = { homeId: 'home-bbbb-2222', name: 'Mac mini' };

/** One Host's MoMo: its own data folder, its own Host key and its own MoMo data key, as `momoHomeFor` makes them. */
export async function host(t: any, id: { homeId: string; name: string }, { granted = true } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'momo-move-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const clock = { at: 1_700_000_000_000, now: () => clock.at };
  const dataKeyDir = path.join(dir, 'config', 'momo');
  const home: any = createMomoHome({
    hostId: id.homeId,
    dataDir: path.join(dir, 'data'),
    safeStorage: createFileSafeStorage(path.join(dir, 'config')),
    dataSafeStorage: createFileSafeStorage(dataKeyDir),
    dataKeyDir,
    clock,
    isMomoChat: (c: string) => c === 'momo-chat',
    report: () => undefined,
  });
  home.move = createMomoMove({ home });
  if (granted) await home.grant({ account: 'a1', features: MOMO });
  t.after(() => home.close());
  /** What the app sees of it: the move steps and the status. */
  const side = {
    call: (op: string, p: object = {}) => home.move[op]({ op, ...p, ...(op === 'reclaim' ? { by: 'test-device' } : {}) }),
    status: async () => home.status(),
  };
  return { dir, clock, home, side, id, momoDir: path.join(dir, 'data', 'momo'), dataKeyDir };
}
/** A Host that is MoMo's home with a fact, an audit entry and a turn in flight. */
export async function studio(t: any) {
  const h = await host(t, A);
  await h.home.start(A);
  const s = h.home.stores();
  await s.memory.save({ text: 'Lives in Berlin', source: { chatId: 'momo-chat', harness: 'claude' } });
  const { id } = await s.audit.intent(act);
  await s.audit.outcome(id, { result: 'done', note: 'ok' });
  await s.turns.accept({ turnId: 'key-00000001', chatId: 'claude:c1', deviceId: 'phone', leaseEpoch: 1 });
  return h;
}
