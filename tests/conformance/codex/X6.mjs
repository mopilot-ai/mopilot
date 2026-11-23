// thread/shellCommand runs unsandboxed (even on a read-only thread) as a userShell turn. No model call.
import fs from 'node:fs';
import { open, sleep } from '../lib/codex.mjs';

export const id = 'X6';
export const title = 'thread/shellCommand';
export const timeoutMs = 120000;

export default async function run(ctx) {
  const c = await open(ctx, 'session');
  const cwd = ctx.cwd('shell');
  const tid = (await c.startThread({ cwd, sandbox: 'read-only' })).result.thread.id;
  const from = c.notes.length;
  const r = await c.request('thread/shellCommand', { threadId: tid, command: 'echo hi > shell_out.txt && echo written', timeoutMs: 20000 });
  const done = await c.waitFor((n) => n.method === 'turn/completed' && n.params?.threadId === tid, 30000, from);
  await sleep(1000);
  const items = c.items(from, tid);
  const o = {
    response: r.result ?? r.error,
    fileWritten: fs.existsSync(`${cwd}/shell_out.txt`),
    turnStatus: done?.params?.turn?.status ?? null,
    items: items.map((i) => ({ type: i.type, source: i.source })),
  };
  return ctx.result(o, {
    'shellCommand returns {}': !r.error,
    'it ignores the read-only sandbox': o.fileWritten,
    'it produces a turn with a userShell commandExecution':
      o.turnStatus === 'completed' && o.items.some((i) => i.type === 'commandExecution' && i.source === 'userShell'),
  });
}
