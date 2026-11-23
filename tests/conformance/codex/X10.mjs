// thread/backgroundTerminals list / terminate / clean.
import { execSync } from 'node:child_process';
import { open, sleep } from '../lib/codex.mjs';

export const id = 'X10';
export const title = 'backgroundTerminals list/terminate/clean';
export const timeoutMs = 300000;

export default async function run(ctx) {
  const secs = 300 + Math.floor(Math.random() * 200);
  const alive = () => execSync(`pgrep -f "^sleep ${secs}$" || true`).toString().trim().split('\n').filter(Boolean).length;
  ctx.defer(() => execSync(`pkill -f "^sleep ${secs}$" || true`));
  const c = await open(ctx, 'session');
  const tid = (await c.startThread()).result.thread.id;
  const r = await c.turn(
    tid,
    `Start the command \`sleep ${secs}\` as a long-running background process in your terminal tool (do not wait for it to finish, use a short yield time), then reply "started". Do not kill it.`,
    {},
    150000,
  );
  const list = await c.request('thread/backgroundTerminals/list', { threadId: tid });
  const entry = list.result?.data?.[0];
  const o = {
    turn: r.status,
    listed: (list.result?.data ?? []).map((t) => ({ command: t.command, keys: Object.keys(t).sort() })),
    aliveBefore: alive(),
  };
  if (entry) {
    o.terminate = (await c.request('thread/backgroundTerminals/terminate', { threadId: tid, processId: entry.processId })).result ?? null;
    await sleep(1000);
    o.listAfterTerminate = ((await c.request('thread/backgroundTerminals/list', { threadId: tid })).result?.data ?? []).length;
    o.aliveAfter = alive();
  }
  const clean = await c.request('thread/backgroundTerminals/clean', { threadId: tid });
  o.clean = clean.error?.message ?? 'ok';
  return ctx.result(o, {
    'list returns the running process': !!entry && String(entry.command).includes(`sleep ${secs}`),
    'terminate kills it and list is empty': o.terminate?.terminated === true && o.listAfterTerminate === 0 && o.aliveAfter === 0,
    'clean exists': o.clean === 'ok',
  });
}
