// extraArgs {'no-chrome': null}, as electron/harness/claude/index.cjs passes it: is --no-chrome really in the argv the CLI is
// started with (read from spawnClaudeCodeProcess, not from --help), does the CLI start with it, and is the
// Claude-in-Chrome integration absent from what it reports? A second session without it is the control.
// No model turn.
import { open } from '../lib/claude.mjs';

export const id = 'C22';
export const title = "extraArgs {'no-chrome': null} reaches the CLI's argv";
export const timeoutMs = 120000;

const chromeNames = (init, status) =>
  [...(init?.tools ?? []), ...(init?.mcp_servers ?? []).map((s) => s.name ?? s), ...(status ?? []).map((s) => s.name)].filter((n) =>
    /chrome/i.test(String(n)),
  );

export default async function run(ctx) {
  const o = {};
  const one = async (name, extra) => {
    const s = open(ctx, name, { captureSpawn: true, permissionMode: 'default', ...extra });
    const init = await s.q.initializationResult();
    const status = await s.q.mcpServerStatus().catch(() => null);
    const argv = s.spawned[0]?.args ?? [];
    const res = {
      argv: argv.filter((a) => /chrome/i.test(a)),
      hasFlag: argv.includes('--no-chrome'),
      commands: init?.commands?.length ?? 0,
      chromeNames: chromeNames(init, status),
      mcpServers: (status ?? []).map((x) => x.name),
    };
    await s.close();
    return res;
  };
  o.withFlag = await one('with', { extraArgs: { 'no-chrome': null } });
  o.without = await one('without', {});
  return ctx.result(o, {
    '--no-chrome is in the argv the CLI is started with': o.withFlag.hasFlag,
    'it is not there without extraArgs': !o.without.hasFlag,
    'the CLI starts with the flag and lists its commands': o.withFlag.commands > 0,
    'no Claude-in-Chrome tool or server is reported with the flag': o.withFlag.chromeNames.length === 0,
  });
}
