// review/start inline on uncommitted changes.
import { execSync } from 'node:child_process';
import { open } from '../lib/codex.mjs';

export const id = 'X4';
export const title = 'review/start inline';
export const timeoutMs = 360000;

export default async function run(ctx) {
  const cwd = ctx.cwd('review');
  execSync(
    'git init -q && git config user.email t@example.invalid && git config user.name t && printf "def add(a, b):\\n    return a + b\\n" > m.py && git add . && git commit -qm init && printf "def add(a, b):\\n    return a - b\\n" > m.py',
    { cwd },
  );
  const c = await open(ctx, 'session');
  const tid = (await c.startThread({ cwd })).result.thread.id;
  const from = c.notes.length;
  const r = await c.request('review/start', { threadId: tid, target: { type: 'uncommittedChanges' }, delivery: 'inline' });
  const done = await c.waitFor((n) => n.method === 'turn/completed' && n.params?.threadId === tid, 300000, from);
  const items = c.items(from, tid);
  const exited = items.find((i) => i.type === 'exitedReviewMode');
  const o = {
    error: r.error?.message ?? null,
    sameThread: r.result?.reviewThreadId === tid,
    turnStatus: done?.params?.turn?.status ?? null,
    itemTypes: items.map((i) => i.type),
    review: String(exited?.review ?? '').slice(0, 400),
  };
  return ctx.result(o, {
    'inline review runs on the same thread': !o.error && o.sameThread,
    'review completes': o.turnStatus === 'completed',
    'entered/exitedReviewMode items wrap the review': o.itemTypes.includes('enteredReviewMode') && o.itemTypes.includes('exitedReviewMode'),
    'the review flags the bug': /\[P\d\]|subtract|minus|a - b/i.test(o.review),
  });
}
