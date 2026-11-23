// '/compact' and '/compact <args>' pass through: status compacting, compact_boundary, local result.
import { open, brief } from '../lib/claude.mjs';

export const id = 'C12';
export const title = "'/compact' passthrough";
export const timeoutMs = 600000;

const sys = (msgs) =>
  msgs
    .filter((m) => m.type === 'system' && m.subtype !== 'thinking_tokens')
    .map((m) => ({
      subtype: m.subtype,
      status: m.status ?? undefined,
      compact_result: m.compact_result,
      compact_error: m.compact_error,
      compact_metadata: m.compact_metadata,
    }));

export default async function run(ctx) {
  const s = open(ctx, 'session', { persist: true });
  const o = {};
  await s.turn('Remember the code word PELICAN. Reply with just ok.', {}, 120000);
  let i0 = s.msgs.length;
  o.plain = { result: brief(await s.turn('/compact', {}, 240000)), system: sys(s.since(i0)) };
  i0 = s.msgs.length;
  o.withArgs = { result: brief(await s.turn('/compact keep only the code word', {}, 240000)), system: sys(s.since(i0)) };
  o.recall = brief(await s.turn('What was the code word? One word.', {}, 120000)).result;
  const boundary = o.plain.system.find((m) => m.subtype === 'compact_boundary');
  return ctx.result(o, {
    '/compact emits status compacting': o.plain.system.some((m) => m.status === 'compacting'),
    '/compact emits compact_boundary with trigger manual': boundary?.compact_metadata?.trigger === 'manual',
    '/compact result has no model turns': o.plain.result?.num_turns === 0,
    '/compact <args> is parsed as the command': o.withArgs.system.some((m) => m.status === 'compacting'),
    'context survives compaction': /PELICAN/i.test(o.recall),
  });
}
