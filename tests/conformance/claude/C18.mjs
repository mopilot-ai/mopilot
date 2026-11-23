// '/goal clear' sent right after interrupt(): does it execute immediately, or wait behind the
// interrupted turn? Tried twice: not awaiting interrupt() (the Pause button), and after the
// interrupted turn's result has arrived.
import fs from 'node:fs';
import { open, brief } from '../lib/claude.mjs';

export const id = 'C18';
export const title = "'/goal clear' right after interrupt()";
export const timeoutMs = 600000;

const RULE =
  'House rule for this session: in each reply create AT MOST ONE new file with the Write tool, then end your reply immediately without doing anything else. Reply now with just "ok".';
const goal = (files) => `/goal the current working directory contains ${files.join(', ')}, each with exactly one line of text`;
const text = (m) => String(m.result ?? '');

export default async function run(ctx) {
  const cwd = ctx.cwd('goal');
  const s = open(ctx, 'session', {
    cwd,
    permissionMode: 'bypassPermissions',
    allowDangerouslySkipPermissions: true,
    perTaskStopAffordance: true,
  });
  const o = {};
  await s.turn(RULE, {}, 120000);

  const round = async (name, files, awaitInterrupt) => {
    const i0 = s.msgs.length;
    s.send(goal(files));
    await s.waitFor((m) => m.type === 'assistant' && m.message?.content?.some((b) => b.type === 'tool_use'), 120000, 'first tool use', i0);
    const t0 = Date.now();
    const at = () => Date.now() - t0;
    const interrupted = s
      .waitFor((m) => m.type === 'result' && !/Goal (cleared|set)|No goal/.test(text(m)), 90000, 'interrupted result', i0)
      .catch(() => null);
    const cleared = s
      .waitFor((m) => m.type === 'result' && /Goal cleared|No goal set/.test(text(m)), 90000, 'goal clear result', i0)
      .catch(() => null);
    const p = s.q.interrupt();
    if (awaitInterrupt) {
      await p;
      await interrupted;
    }
    const sentAt = at();
    s.send('/goal clear');
    const [ri, rc] = await Promise.all([interrupted, cleared]);
    const clearedAt = at();
    const order = s
      .since(i0)
      .filter((m) => m.type === 'result')
      .map((m) => text(m).slice(0, 40));
    const n1 = fs.readdirSync(cwd).length;
    await new Promise((r) => setTimeout(r, 15000));
    const n2 = fs.readdirSync(cwd).length;
    const show = brief(await s.turn('/goal', {}, 60000));
    o[name] = {
      clearSentAfterMs: sentAt,
      clearResultAfterMs: clearedAt,
      clearResult: brief(rc),
      interruptedResult: brief(ri),
      resultOrder: order,
      filesAtClear: n1,
      filesFifteenSecondsLater: n2,
      showAfter: show,
    };
  };
  await round('notAwaited', ['a1.txt', 'a2.txt', 'a3.txt', 'a4.txt'], false);
  await round('awaited', ['b1.txt', 'b2.txt', 'b3.txt', 'b4.txt'], true);
  await s.close();

  const ok = (r) =>
    r.clearResultAfterMs < 5000 &&
    /^Goal cleared:/.test(r.clearResult?.result) &&
    r.clearResult?.num_turns === 0 &&
    r.resultOrder.length === 2 &&
    r.resultOrder[1].startsWith('Goal cleared') &&
    r.interruptedResult?.subtype === 'error_during_execution' &&
    r.filesFifteenSecondsLater === r.filesAtClear &&
    /^No goal set/.test(r.showAfter?.result);
  return ctx.result(o, {
    "'/goal clear' sent without awaiting interrupt() executes at once (local, within 5 s), after the interrupted turn's result": ok(
      o.notAwaited,
    ),
    "'/goal clear' sent after the interrupted result executes at once too": ok(o.awaited),
    'the interrupted turn ends as error_during_execution and the cleared goal does not keep the loop going':
      o.notAwaited.interruptedResult?.is_error === true && o.notAwaited.filesFifteenSecondsLater === o.notAwaited.filesAtClear,
  });
}
