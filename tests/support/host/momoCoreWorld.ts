// A running home with the gate, learning and notes services over a clock the test moves, and the small helpers the Host tests of the review share.
import { A, host } from './momoMoveWorld.ts';
// @ts-ignore: plain ESM without declarations
import gateService from '../../../host/src/momoServices/gate.mjs';
// @ts-ignore
import learningService from '../../../host/src/momoServices/learning.mjs';
// @ts-ignore
import notesService from '../../../host/src/momoServices/notes.mjs';

/** A running home with the three services over a clock the test moves. */
export async function world(t: any, extra: { report?: (m: string) => void } = {}) {
  const h = await host(t, A);
  const clock = { at: new Date(2026, 10, 22, 12, 0).getTime() };
  const deps = { home: h.home, now: () => clock.at, ...extra };
  gateService(deps);
  learningService(deps);
  notesService(deps);
  await h.home.start(A);
  t.after(() => h.home.lifecycle('pause'));
  const svc = (id: string) => h.home.service(id);
  return { ...h, clock, deps, gate: svc('gate'), learning: svc('learning'), notes: svc('notes'), run: (h.home as any).gate };
}
export const code = (p: Promise<unknown>) =>
  p.then(
    () => 'ran',
    (e: any) => e.code,
  );
export const chat = (over: object = {}) => ({ chatId: 'momo-chat', origin: 'chat' as const, ...over });
/** Makes every audit line of the home fail, until `fix()` is called. */
export function breakAudit(h: any) {
  const real = h.home.stores.bind(h.home);
  let broken = true;
  h.home.stores = () => {
    const s = real();
    return s && broken
      ? {
          ...s,
          audit: {
            intent: () => Promise.reject(new Error('disk full')),
            refusal: () => Promise.reject(new Error('disk full')),
            outcome: () => Promise.reject(new Error('disk full')),
          },
        }
      : s;
  };
  return () => void (broken = false);
}
