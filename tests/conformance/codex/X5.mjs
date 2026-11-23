// thread/compact/start: a turn holding only a contextCompaction item; no thread/compacted.
import { open, sleep } from '../lib/codex.mjs';

export const id = 'X5';
export const title = 'thread/compact/start';
export const timeoutMs = 300000;

export default async function run(ctx) {
  const c = await open(ctx, 'session');
  const tid = (await c.startThread()).result.thread.id;
  await c.turn(tid, 'Reply with exactly: ok', {}, 90000);
  const from = c.notes.length;
  const r = await c.request('thread/compact/start', { threadId: tid });
  const done = await c.waitFor((n) => n.method === 'turn/completed' && n.params?.threadId === tid, 120000, from);
  await sleep(1000);
  const o = {
    response: r.result ?? r.error,
    turnStatus: done?.params?.turn?.status ?? null,
    itemTypes: c.items(from, tid).map((i) => i.type),
    methods: c.methods(from, tid).filter((m) => !/delta|tokenUsage|rateLimits/.test(m)),
  };
  return ctx.result(o, {
    'compact/start returns {}': !r.error && Object.keys(r.result ?? {}).length === 0,
    'it runs as a turn': o.turnStatus === 'completed',
    'the turn holds only a contextCompaction item': o.itemTypes.length === 1 && o.itemTypes[0] === 'contextCompaction',
    'deprecated thread/compacted is not emitted': !o.methods.includes('thread/compacted'),
  });
}
