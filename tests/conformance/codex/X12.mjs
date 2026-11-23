// Does a plain thread carry native computer use (cua_repl from the unified-computer-use plugin),
// and which per-thread or per-process switches remove it? No model call.
import { open, sleep } from '../lib/codex.mjs';

export const id = 'X12';
export const title = 'Native computer use present in a plain thread?';
export const timeoutMs = 300000;

const PLUGIN = 'unified-computer-use@openai-bundled';
const VARIANTS = [
  { name: 'baseline', args: [], cfg: {} },
  { name: 'proc_disable_computer_use', args: ['--disable', 'computer_use'], cfg: {} },
  { name: 'thread_features_computer_use_false', args: [], cfg: { features: { computer_use: false } } },
  { name: 'thread_plugin_disabled', args: [], cfg: { plugins: { [PLUGIN]: { enabled: false } } } },
  { name: 'proc_plugin_disabled', args: ['-c', `plugins.${PLUGIN}.enabled=false`], cfg: {} },
];

export default async function run(ctx) {
  const o = {};
  for (const v of VARIANTS) {
    const c = await open(ctx, v.name, { args: v.args });
    const t = await c.startThread({ ephemeral: true, config: v.cfg });
    if (t.error) {
      o[v.name] = { startError: t.error.message };
    } else {
      await sleep(3000);
      const s = await c.request('mcpServerStatus/list', { threadId: t.result.thread.id }, 90000);
      o[v.name] = s.error ? { error: s.error.message } : (s.result?.data ?? []).map((x) => x.name);
    }
    await c.close();
  }
  const has = (k) => Array.isArray(o[k]) && o[k].includes('cua_repl');
  if (!has('baseline'))
    return ctx.result(
      { ...o, note: `cua_repl is not loaded on this machine (no ${PLUGIN} plugin); nothing to check` },
      {},
      { verdict: 'skip' },
    );
  return ctx.result(o, {
    'a plain thread loads cua_repl': true,
    '--disable computer_use does not remove it': has('proc_disable_computer_use'),
    'features.computer_use=false does not remove it': has('thread_features_computer_use_false'),
    'per-thread plugin enabled=false removes it': Array.isArray(o.thread_plugin_disabled) && !has('thread_plugin_disabled'),
    'per-process plugin enabled=false removes it': Array.isArray(o.proc_plugin_disabled) && !has('proc_plugin_disabled'),
  });
}
