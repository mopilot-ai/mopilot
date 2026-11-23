// D-68, hook rewrite: a PreToolUse hook (SDK `hooks` option) returns updatedInput that wraps the Bash command so its output also goes
// to a Sage-owned file (`set -o pipefail; { CMD } 2>&1 | tee -a FILE`). Main could tail that file while the command runs. Does the
// rewrite reach the CLI, does the file grow while it runs, and does the model see exactly what it sees without the hook (exit code,
// is_error, text)? And what does the pipe cost: a `cd` inside the command no longer persists to the next call. A baseline session
// without the hook runs the same commands. Four short turns on the cheapest model, in a temp dir.
import fs from 'node:fs';
import path from 'node:path';
import { open, sleep } from '../lib/claude.mjs';

export const id = 'C26';
export const title = 'D-68 PreToolUse hook rewrites Bash to tee into a file: tail works, result unchanged, cd no longer persists';
export const timeoutMs = 400000;

const ask = (cmd) => `Run exactly this one bash command with the Bash tool, do not change it, then reply with just "done":\n${cmd}`;
const SLOW = 'for i in 1 2 3; do echo s$i; echo e$i 1>&2; sleep 2; done; sh -c "exit 3"';

export default async function run(ctx) {
  const outDir = ctx.cwd('tee');
  const wrap = (cmd, file) => `set -o pipefail\n{\n${cmd}\n} 2>&1 | tee -a '${file}'`;
  const rewrites = [];
  const sessions = {};
  const o = {};
  for (const withHook of [false, true]) {
    const key = withHook ? 'hook' : 'plain';
    const cwd = ctx.cwd(`bash-${key}`);
    fs.mkdirSync(path.join(cwd, 'sub'));
    const hooks = withHook
      ? {
          PreToolUse: [
            {
              matcher: 'Bash',
              hooks: [
                async (input) => {
                  const file = path.join(outDir, `${input.tool_use_id}.out`);
                  rewrites.push({ file, original: input.tool_input.command });
                  return {
                    hookSpecificOutput: {
                      hookEventName: 'PreToolUse',
                      permissionDecision: 'allow',
                      updatedInput: { ...input.tool_input, command: wrap(input.tool_input.command, file) },
                    },
                  };
                },
              ],
            },
          ],
        }
      : undefined;
    const s = open(ctx, key, {
      cwd,
      permissionMode: 'bypassPermissions',
      allowDangerouslySkipPermissions: true,
      ...(hooks ? { hooks } : {}),
    });
    sessions[key] = s;
    const grab = (i0) => {
      const mine = s.since(i0);
      const use = mine
        .flatMap((m) => (m.type === 'assistant' ? (m.message?.content ?? []) : []))
        .find((b) => b.type === 'tool_use' && b.name === 'Bash');
      const res = mine.find(
        (m) =>
          m.type === 'user' &&
          Array.isArray(m.message?.content) &&
          m.message.content.some((b) => b.type === 'tool_result' && b.tool_use_id === use?.id),
      );
      const block = res?.message.content.find((b) => b.type === 'tool_result');
      return {
        command: use?.input?.command,
        isError: !!block?.is_error,
        content: typeof block?.content === 'string' ? block.content : JSON.stringify(block?.content),
        toolUseResult: res?.tool_use_result ?? null,
      };
    };
    // 1. slow command with stdout, stderr and a non-zero exit; sample the tee file while it runs
    const samples = [];
    let i0 = s.msgs.length;
    const sampler = (async () => {
      const t0 = Date.now();
      while (Date.now() - t0 < 12000) {
        const f = rewrites.at(-1)?.file;
        if (withHook && f) {
          try {
            samples.push({ relMs: Date.now() - t0, size: fs.statSync(f).size });
          } catch {
            /* the transcript may be mid-rewrite; skip this sample */
          }
        }
        await sleep(700);
      }
    })();
    await s.turn(ask(SLOW), {}, 120000);
    await sampler;
    o[key] = { slow: grab(i0), sizesWhileRunning: [...new Set(samples.map((x) => x.size))] };
    if (withHook) o[key].teeFile = fs.readFileSync(rewrites[0].file, 'utf8').slice(0, 200);
    // 2. cd persistence across two calls
    i0 = s.msgs.length;
    await s.turn(ask('cd sub && echo in-sub'), {}, 120000);
    o[key].cd = grab(i0);
    i0 = s.msgs.length;
    await s.turn(ask('basename "$PWD"'), {}, 120000);
    o[key].pwdAfter = grab(i0);
    await s.close();
  }
  const norm = (t) => String(t ?? '').replace(/\s+$/, '');
  const same = norm(o.hook.slow.content) === norm(o.plain.slow.content);
  o.rewrittenCommandSeenByModel = o.hook.slow.command;
  o.sameText = same;
  return ctx.result(o, {
    'the hook rewrite reaches the CLI (a tee file appears)': rewrites.length >= 1 && !!o.hook.teeFile,
    'the file grows while the command runs (three or more distinct sizes)': o.hook.sizesWhileRunning.length >= 3,
    'the file holds stdout and stderr interleaved': /s1/.test(o.hook.teeFile ?? '') && /e1/.test(o.hook.teeFile ?? ''),
    'with pipefail the exit code is kept: is_error and "Exit code 3" in both sessions':
      o.hook.slow.isError === true &&
      o.plain.slow.isError === true &&
      /^Exit code 3\n/.test(o.hook.slow.content ?? '') &&
      /^Exit code 3\n/.test(o.plain.slow.content ?? ''),
    'the text the model gets back is identical with and without the hook': same,
    'the model still sees its own original command in the tool_use (the rewrite is invisible to it)': o.hook.slow.command === SLOW,
    'without the hook a cd persists to the next Bash call': /sub/.test(o.plain.pwdAfter.content ?? ''),
    'with the pipe rewrite a cd inside the command is lost for the next call (the cost of this channel)': !/sub/.test(
      o.hook.pwdAfter.content ?? '',
    ),
  });
}
