// The command list Sage can show, and how local-only commands answer. No model call.
import { open, brief } from '../lib/claude.mjs';

export const id = 'C3';
export const title = 'supportedCommands() / init.slash_commands and terminal-only flag';
export const timeoutMs = 180000;

export default async function run(ctx) {
  const s = open(ctx, 'session');
  const initResult = await s.q.initializationResult();
  const supported = await s.q.supportedCommands();
  const names = supported.map((c) => c.name);
  const byName = Object.fromEntries(supported.map((c) => [c.name, c]));
  const unavailable = {};
  for (const cmd of ['/tasks', '/status']) unavailable[cmd] = brief(await s.turn(cmd, { origin: { kind: 'human' } }, 60000));
  const init = s.msgs.find((m) => m.type === 'system' && m.subtype === 'init');
  const fields = [...new Set(supported.flatMap((c) => Object.keys(c)))].sort();
  const observed = {
    count: names.length,
    fields,
    sameAsInitializationResult: JSON.stringify(initResult.commands?.map((c) => c.name)) === JSON.stringify(names),
    codeReviewAliases: byName['code-review']?.aliases ?? null,
    terminal_slash_commands: init?.terminal_slash_commands ?? null,
    unavailable,
  };
  return ctx.result(observed, {
    'supportedCommands() equals initializationResult().commands': observed.sameAsInitializationResult,
    'goal, code-review, init, compact, context, effort are listed': ['goal', 'code-review', 'init', 'compact', 'context', 'effort'].every(
      (n) => names.includes(n),
    ),
    'code-review has alias review': (byName['code-review']?.aliases ?? []).includes('review'),
    'rewind is not a command': !names.includes('rewind'),
    'commands carry no terminal-only flag': fields.every((f) => ['name', 'description', 'argumentHint', 'aliases', 'builtin'].includes(f)),
    'terminal_slash_commands is on init': Array.isArray(init?.terminal_slash_commands),
    'unlisted commands answer locally as unavailable': Object.values(unavailable).every(
      (r) => r?.num_turns === 0 && /isn't available/.test(r.result),
    ),
  });
}
