// D-68, background shell: with run_in_background the Bash tool returns at once. Does the SDK expose the shell's output file (task_started /
// task_notification output_file, the tool_result text), can main tail that file while the command runs, does getTaskOutput answer for it,
// and does the stream carry anything (BashOutput results, task_progress) while it runs? One short turn on the cheapest model, in a temp dir.
import fs from 'node:fs';
import { open, sleep } from '../lib/claude.mjs';

export const id = 'C25';
export const title = 'D-68 background shell: output file path, tailing it, getTaskOutput, stream events while it runs';
export const timeoutMs = 300000;

const CMD = 'for i in 1 2 3 4 5; do echo bg$i; sleep 2; done';

export default async function run(ctx) {
  const s = open(ctx, 'bg', {
    cwd: ctx.cwd('bash'),
    permissionMode: 'bypassPermissions',
    allowDangerouslySkipPermissions: true,
    keepStreamEvents: false,
  });
  const fileSamples = [];
  const apiSamples = [];
  let stop = false;
  const tailer = (async () => {
    const st = await s.waitFor((m) => m.subtype === 'task_started' && m.task_type === 'local_bash', 120000, 'task_started');
    const t0 = st.__at;
    while (!stop) {
      const rel = Date.now() - t0;
      const o = await s.q.getTaskOutput(st.task_id).catch((e) => ({ error: String(e?.message || e).slice(0, 120) }));
      apiSamples.push({ relMs: rel, bytes: o.total_bytes, error: o.error });
      await sleep(1000);
    }
  })();
  const i0 = s.msgs.length;
  await s.turn(
    `Use the Bash tool with run_in_background set to true to run exactly this command, do not change it. Do not wait for it and do not read its output. Reply with just "started":\n${CMD}`,
    {},
    150000,
  );
  const started = s.msgs.find((m) => m.subtype === 'task_started' && m.task_type === 'local_bash');
  const use = s.msgs
    .flatMap((m) => (m.type === 'assistant' ? (m.message?.content ?? []) : []))
    .find((b) => b.type === 'tool_use' && b.name === 'Bash');
  const res = s.msgs.find(
    (m) =>
      m.type === 'user' &&
      Array.isArray(m.message?.content) &&
      m.message.content.some((b) => b.type === 'tool_result' && b.tool_use_id === use?.id),
  );
  const resBlock = res?.message.content.find((b) => b.type === 'tool_result');
  const resText = typeof resBlock?.content === 'string' ? resBlock.content : JSON.stringify(resBlock?.content);
  const pathInText = resText?.match(/(\/[^\s"'`]+\.output)/)?.[1] ?? resText?.match(/(\/[^\s"'`]+)/)?.[1] ?? null;
  const turnEnd = Date.now();
  // the turn is over; the shell still runs (about 10 s in all). Tail the file by path.
  const bgFile = started?.output_file || pathInText;
  while (Date.now() - turnEnd < 14000) {
    try {
      if (bgFile)
        fileSamples.push({
          relMs: Date.now() - turnEnd,
          size: fs.statSync(bgFile).size,
          text: fs.readFileSync(bgFile, 'utf8').slice(0, 60),
        });
    } catch (e) {
      fileSamples.push({ relMs: Date.now() - turnEnd, error: e.code });
    }
    await sleep(1000);
  }
  stop = true;
  await tailer.catch(() => {});
  const after = s.since(i0);
  const notif = after.find((m) => m.subtype === 'task_notification');
  const live = after.filter(
    (m) =>
      m.__at < (notif?.__at ?? Infinity) &&
      m.__at > (res?.__at ?? 0) &&
      !['assistant', 'result', 'user'].includes(m.type) &&
      m.subtype !== 'thinking_tokens',
  );
  await s.close();

  const o = {
    toolResultText: resText?.slice(0, 300),
    taskStarted: started && {
      task_type: started.task_type,
      is_backgrounded: started.is_backgrounded,
      output_file: started.output_file ?? null,
    },
    pathFoundInToolResultText: pathInText,
    taskNotification: notif && { status: notif.status, output_file: notif.output_file, summary: notif.summary },
    fileSamples,
    getTaskOutputSamples: apiSamples,
    typesAfterToolResultUntilNotification_exceptModelReply: [...new Set(live.map((m) => `${m.type}${m.subtype ? `/${m.subtype}` : ''}`))],
    toolProgress: after.filter((m) => m.type === 'tool_progress').length,
  };
  const grew = new Set(fileSamples.filter((x) => !x.error).map((x) => x.size));
  const apiGrew = new Set(apiSamples.filter((x) => !x.error && x.bytes != null).map((x) => x.bytes));
  return ctx.result(o, {
    'the background shell is a task with is_backgrounded true': started?.task_type === 'local_bash' && started?.is_backgrounded === true,
    'its output file path is on the stream (task_started or the tool_result text)': !!bgFile,
    'the file exists and grows while the shell runs, so main can tail it': grew.size >= 2,
    'getTaskOutput answers for it while it runs and grows': apiGrew.size >= 2,
    'nothing but task bookends and background_tasks_changed arrives on the stream while it runs (no tool_progress)':
      o.toolProgress === 0 &&
      live.every(
        (m) =>
          ['task_notification', 'background_tasks_changed', 'task_updated', 'status', 'task_started'].includes(m.subtype) ||
          m.type === 'rate_limit_event',
      ),
  });
}
