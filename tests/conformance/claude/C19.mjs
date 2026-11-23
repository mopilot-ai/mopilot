// What a Bash tool result carries (D-68): the structured `tool_use_result` (stdout, stderr, ...), how a non-zero exit is reported, and whether
// anything arrives while the command runs. Three short turns on the cheapest model, in a temp dir.
import { open } from '../lib/claude.mjs';

export const id = 'C19';
export const title = 'Bash tool result: how the exit code, stdout and stderr arrive, and nothing while it runs';
export const timeoutMs = 300000;

const ask = (cmd) => `Run exactly this one bash command with the Bash tool, do not change it, then reply with just "done":\n${cmd}`;
const clip = (v) => (typeof v === 'string' ? (v.length > 200 ? `${v.slice(0, 200)}…` : v) : v);
const shape = (o) =>
  o && typeof o === 'object' ? Object.fromEntries(Object.entries(o).map(([k, v]) => [k, typeof v === 'string' ? clip(v) : v])) : o;

export default async function run(ctx) {
  const s = open(ctx, 'session', { cwd: ctx.cwd('bash'), permissionMode: 'bypassPermissions', allowDangerouslySkipPermissions: true });
  const o = {};
  const probe = async (name, cmd) => {
    const i0 = s.msgs.length;
    const t0 = Date.now();
    await s.turn(ask(cmd), {}, 120000);
    const mine = s.since(i0);
    const use = mine
      .flatMap((m) => (m.type === 'assistant' ? (m.message?.content ?? []) : []))
      .find((b) => b.type === 'tool_use' && b.name === 'Bash');
    const resultMsg = mine.find(
      (m) =>
        m.type === 'user' &&
        Array.isArray(m.message?.content) &&
        m.message.content.some((b) => b.type === 'tool_result' && b.tool_use_id === use?.id),
    );
    const block = resultMsg?.message.content.find((b) => b.type === 'tool_result');
    const useAt = mine.findIndex((m) => m.type === 'assistant' && m.message?.content?.some((b) => b.id === use?.id));
    const resAt = mine.indexOf(resultMsg);
    const between = mine.slice(useAt + 1, resAt);
    o[name] = {
      command: use?.input?.command ?? null,
      isError: !!block?.is_error,
      content: clip(typeof block?.content === 'string' ? block.content : JSON.stringify(block?.content ?? null)),
      toolUseResult: shape(resultMsg?.tool_use_result ?? resultMsg?.toolUseResult ?? null),
      toolUseResultKeys:
        resultMsg?.tool_use_result && typeof resultMsg.tool_use_result === 'object' ? Object.keys(resultMsg.tool_use_result).sort() : null,
      topLevelKeys: Object.keys(resultMsg ?? {}).sort(),
      betweenToolUseAndResult: between.map((m) => `${m.type}${m.subtype ? `/${m.subtype}` : ''}`),
      toolProgress: between.filter((m) => m.type === 'tool_progress').map((m) => ({ name: m.tool_name, elapsed: m.elapsed_time_seconds })),
      seconds: Math.round((Date.now() - t0) / 1000),
    };
  };
  await probe('ok', 'echo to-stdout; echo to-stderr 1>&2');
  await probe('exit3', 'echo before-fail; sh -c "exit 3"');
  await probe('slow', 'for i in 1 2 3 4; do echo line$i; sleep 2; done');
  await s.close();

  const tur = (n) => o[n].toolUseResult;
  const keys = (n) => (tur(n) && typeof tur(n) === 'object' ? Object.keys(tur(n)).sort().join(',') : null);
  return ctx.result(o, {
    'a command that exits 0 is not an error and has a structured tool_use_result with stdout, stderr, interrupted': ['ok', 'slow'].every(
      (n) => !o[n].isError && ['stdout', 'stderr', 'interrupted'].every((k) => tur(n) && k in tur(n)),
    ),
    'that structured result has no exit code field': ['ok', 'slow'].every(
      (n) => keys(n) === 'interrupted,isImage,noOutputExpected,stderr,stdout',
    ),
    'stderr is merged into stdout (the stderr field stays empty)':
      /to-stdout/.test(tur('ok')?.stdout ?? '') && /to-stderr/.test(tur('ok')?.stdout ?? '') && tur('ok')?.stderr === '',
    'a non-zero exit is flagged is_error and the text starts "Exit code N"':
      o.exit3.isError === true && /^Exit code 3\n/.test(o.exit3.content),
    'for a non-zero exit tool_use_result is a string, "Error: Exit code N\\n<output>", not an object':
      typeof tur('exit3') === 'string' && /^Error: Exit code 3\n/.test(tur('exit3')),
    'nothing but task_started and task_notification arrives while a slow command runs (no output, no tool_progress)':
      o.slow.betweenToolUseAndResult.every((t) => t === 'system/task_started' || t === 'system/task_notification') &&
      o.slow.toolProgress.length === 0,
  });
}
