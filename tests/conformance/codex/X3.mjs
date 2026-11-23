// Plan collaboration mode per turn, back to default, and thread/settings/update without a turn.
import fs from 'node:fs';
import { open } from '../lib/codex.mjs';

export const id = 'X3';
export const title = 'Plan collaboration mode';
export const timeoutMs = 480000;

export default async function run(ctx) {
  const c = await open(ctx, 'session');
  const cwd = ctx.cwd('plan');
  const tid = (await c.startThread({ cwd })).result.thread.id;
  const mode = (m) => ({
    collaborationMode: { mode: m, settings: { model: ctx.model, reasoning_effort: ctx.effort, developer_instructions: null } },
  });
  const modesSince = (from) =>
    c.notes
      .slice(from)
      .filter((n) => n.method === 'thread/settings/updated')
      .map((n) => n.params.threadSettings?.collaborationMode?.mode);
  const p = await c.turn(
    tid,
    'Plan (do not execute) how to create hello.txt containing the word hi in the current directory. Keep the plan to two short steps.',
    mode('plan'),
  );
  const planItems = c.items(p.from, tid);
  const o = {
    plan: {
      status: p.status,
      modes: modesSince(p.from),
      itemTypes: [...new Set(planItems.map((i) => i.type))],
      fileChanges: planItems.filter((i) => i.type === 'fileChange').length,
      files: fs.readdirSync(cwd),
    },
  };
  const d = await c.turn(tid, 'Implement the plan.', mode('default'));
  o.default = { status: d.status, modes: modesSince(d.from), created: fs.existsSync(`${cwd}/hello.txt`) };
  const from = c.notes.length;
  const upd = await c.request('thread/settings/update', { threadId: tid, ...mode('plan') });
  await c.waitFor((n) => n.method === 'thread/settings/updated', 5000, from);
  o.settingsUpdate = { error: upd.error?.message ?? null, modes: modesSince(from) };
  return ctx.result(o, {
    'plan turn emits thread/settings/updated mode plan': o.plan.modes.includes('plan'),
    'plan turn makes no file changes': o.plan.fileChanges === 0 && !o.plan.files.includes('hello.txt'),
    'default turn switches back and implements': o.default.modes.includes('default') && o.default.created,
    'thread/settings/update sets the mode without a turn': !o.settingsUpdate.error && o.settingsUpdate.modes.includes('plan'),
  });
}
