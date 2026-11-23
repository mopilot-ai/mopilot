// D-68, control channel: the SDK Query has a `get_task_output` control request (runtime method getTaskOutput, absent from sdk.d.ts's Query
// interface): "reads the end of one background shell or Monitor task's output, at most 8 KiB, a host polls it while the task runs".
// Is it answered for a FOREGROUND Bash task (the task_id from task_started) while the command is still running, and does the
// output grow between polls? A control request is not a model turn. One short turn on the cheapest model, in a temp dir.
import { open, sleep } from '../lib/claude.mjs';

export const id = 'C24';
export const title = 'D-68 control channel: getTaskOutput polled while a foreground Bash runs';
export const timeoutMs = 300000;

const CMD = 'for i in 1 2 3 4 5; do echo line$i; sleep 2; done';

export default async function run(ctx) {
  const s = open(ctx, 'poll', { cwd: ctx.cwd('bash'), permissionMode: 'bypassPermissions', allowDangerouslySkipPermissions: true });
  const samples = [];
  let stop = false;
  let started = null;
  let resultAt = null;
  const poller = (async () => {
    started = await s.waitFor((m) => m.subtype === 'task_started' && m.task_type === 'local_bash', 120000, 'task_started');
    const t0 = started.__at;
    while (!stop) {
      const at = Date.now();
      try {
        const r = await s.q.getTaskOutput(started.task_id);
        samples.push({ relMs: at - t0, bytes: r.total_bytes, truncated: r.truncated, output: r.output });
      } catch (e) {
        samples.push({ relMs: at - t0, error: String(e?.message || e).slice(0, 200) });
      }
      await sleep(700);
    }
  })();
  const t = Date.now();
  const r = await s.turn(
    `Run exactly this one bash command with the Bash tool, do not change it, then reply with just "done":\n${CMD}`,
    {},
    150000,
  );
  resultAt = Date.now();
  stop = true;
  await poller.catch(() => {});
  const tail = await s.q.getTaskOutput(started.task_id).catch((e) => ({ error: String(e?.message || e).slice(0, 200) }));
  await s.close();

  const use = s.msgs.find((m) => m.type === 'assistant' && m.message?.content?.some((b) => b.type === 'tool_use' && b.name === 'Bash'));
  const toolResultAt = s.msgs.find(
    (m) => m.type === 'user' && Array.isArray(m.message?.content) && m.message.content.some((b) => b.type === 'tool_result'),
  )?.__at;
  const toolResult = s.msgs
    .find((m) => m.type === 'user' && Array.isArray(m.message?.content) && m.message.content.some((b) => b.type === 'tool_result'))
    ?.message.content.find((b) => b.type === 'tool_result');
  const finalText = typeof toolResult?.content === 'string' ? toolResult.content : '';
  // a poll that was out when the command ended comes back empty (the task is gone): it is not a live sample
  const live = samples.filter((x) => !x.error && x.bytes > 0 && started.__at + x.relMs < toolResultAt);
  const distinct = [...new Set(live.map((x) => x.bytes))];
  const o = {
    startedLagMs: started.__at - use.__at,
    commandMs: toolResultAt - use.__at,
    pollsWhileRunning: live.length,
    errors: [...new Set(samples.filter((x) => x.error).map((x) => x.error))],
    distinctSizesWhileRunning: distinct,
    samples: samples.map((x) => ({ relMs: x.relMs, bytes: x.bytes, error: x.error, output: x.output?.slice(0, 80) })),
    afterEnd: tail.error ? tail : { bytes: tail.total_bytes, output: tail.output?.slice(0, 80) },
    finalText,
    turnMs: resultAt - t,
    resultOk: r.subtype,
  };
  return ctx.result(o, {
    'getTaskOutput answers for a foreground Bash task while it runs': live.length >= 2,
    'its output grows between polls while the command is still running': distinct.length >= 2,
    'the first live poll already holds the lines printed so far (not empty)': live.length > 0 && /line1/.test(live[0].output ?? ''),
    'every live poll is a prefix of the final tool result text':
      live.length > 0 && live.every((x) => finalText.startsWith(x.output.trimEnd())),
    'a poll that races the end of the command comes back empty (the task is already gone), never an error': samples.every((x) => !x.error),
  });
}
