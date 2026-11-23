// A slash command is recognized only as the last text block of a multi-block message.
import fs from 'node:fs';
import path from 'node:path';
import { open, brief, assistantText } from '../lib/claude.mjs';
import { wordPng } from '../lib/png.mjs';

export const id = 'C11';
export const title = 'Block order: slash command last vs not last';
export const timeoutMs = 600000;

export default async function run(ctx) {
  const img = { type: 'image', source: { type: 'base64', media_type: 'image/png', data: wordPng('OK').toString('base64') } };
  const handoff = { type: 'text', text: '[Handoff from a previous segment] The user was working on small text files in this directory.' };
  const goal = { type: 'text', text: '/goal the current working directory contains ok.txt' };
  const out = {};
  for (const [label, content] of [
    ['last', [handoff, img, goal]],
    ['first', [goal, img, handoff]],
    ['middle', [handoff, goal, img]],
  ]) {
    const cwd = ctx.cwd(label);
    fs.writeFileSync(path.join(cwd, 'ok.txt'), 'ok\n');
    const s = open(ctx, label, { cwd, persist: true, permissionMode: 'bypassPermissions', allowDangerouslySkipPermissions: true });
    const r = await s.turn(content, { origin: { kind: 'human' } }, 180000);
    out[label] = { goalSet: /^Goal set:/m.test(assistantText(s.msgs)), result: brief(r) };
    await s.turn('/goal clear', {}, 60000).catch(() => null);
    await s.close();
  }
  return ctx.result(out, {
    'command as last block is recognized': out.last.goalSet,
    'command as first block is not recognized': !out.first.goalSet,
    'command in the middle is not recognized': !out.middle.goalSet,
  });
}
