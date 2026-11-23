// Can a thread switch off the user's own node_repl MCP server and the codex_apps connector tools?
// Each variant starts an ephemeral thread with a per-thread (or per-process) override and lists the
// MCP servers that thread actually loaded. Runs in a throwaway CODEX_HOME. No model call.
import fs from 'node:fs';
import path from 'node:path';
import { open, tempHome, sleep } from '../lib/codex.mjs';

export const id = 'X14';
export const title = 'node_repl and codex_apps switched off per thread?';
export const timeoutMs = 400000;

const VARIANTS = [
  { name: 'baseline', args: [], cfg: {} },
  { name: 'thread_node_repl_off', args: [], cfg: { mcp_servers: { node_repl: { enabled: false } } } },
  { name: 'thread_codex_apps_mcp_off', args: [], cfg: { mcp_servers: { codex_apps: { enabled: false } } } },
  { name: 'thread_features_apps_off', args: [], cfg: { features: { apps: false } } },
  { name: 'thread_features_connectors_off', args: [], cfg: { features: { connectors: false } } },
  { name: 'thread_apps_default_off', args: [], cfg: { apps: { _default: { enabled: false } } } },
  { name: 'proc_disable_apps', args: ['--disable', 'apps'], cfg: {} },
  // a user who never configured node_repl: is the same override still accepted?
  { name: 'no_node_repl_configured', home: 'bare', args: [], cfg: { mcp_servers: { node_repl: { enabled: false } } } },
  { name: 'thread_both_off', args: [], cfg: { mcp_servers: { node_repl: { enabled: false } }, features: { apps: false } } },
];

export default async function run(ctx) {
  const env = tempHome(ctx);
  const bare = tempHome(ctx, 'codex-home-bare');
  const cfgFile = path.join(bare.CODEX_HOME, 'config.toml');
  if (fs.existsSync(cfgFile))
    fs.writeFileSync(
      cfgFile,
      fs
        .readFileSync(cfgFile, 'utf8')
        .split(/\n(?=\[)/)
        .filter((sec) => !/^\[mcp_servers\.node_repl[\].]/.test(sec))
        .join('\n'),
    );
  const o = {};
  for (const v of VARIANTS) {
    const c = await open(ctx, v.name, { args: v.args, env: v.home ? bare : env });
    const t = await c.startThread({ ephemeral: true, config: v.cfg });
    if (t.error) {
      o[v.name] = { startError: t.error.message };
    } else {
      await sleep(4000);
      const s = await c.request('mcpServerStatus/list', { threadId: t.result.thread.id }, 90000);
      o[v.name] = s.error
        ? { error: s.error.message }
        : Object.fromEntries((s.result?.data ?? []).map((x) => [x.name, Object.keys(x.tools ?? {}).length]));
    }
    await c.close();
  }
  const has = (k, n) => !!o[k] && !o[k].startError && !o[k].error && n in o[k];
  const loaded = (k, n) => has(k, n) && o[k][n] > 0;
  if (!loaded('baseline', 'node_repl') && !loaded('baseline', 'codex_apps'))
    return ctx.result(
      { ...o, note: 'neither node_repl nor codex_apps is loaded on this machine; nothing to check' },
      {},
      { verdict: 'skip' },
    );
  return ctx.result(o, {
    'a plain thread loads node_repl tools and codex_apps tools': loaded('baseline', 'node_repl') && loaded('baseline', 'codex_apps'),
    'per-thread mcp_servers.node_repl.enabled=false leaves node_repl with no tools':
      has('thread_node_repl_off', 'node_repl') && o.thread_node_repl_off.node_repl === 0,
    'that does not touch codex_apps': loaded('thread_node_repl_off', 'codex_apps'),
    'per-thread mcp_servers.codex_apps.enabled=false is rejected (invalid transport)': /invalid transport/.test(
      o.thread_codex_apps_mcp_off?.startError ?? '',
    ),
    'per-thread features.apps=false removes codex_apps and keeps node_repl':
      !!o.thread_features_apps_off && !('codex_apps' in o.thread_features_apps_off) && loaded('thread_features_apps_off', 'node_repl'),
    'per-process --disable apps removes codex_apps': !!o.proc_disable_apps && !('codex_apps' in o.proc_disable_apps),
    'features.connectors=false also removes codex_apps': !('codex_apps' in (o.thread_features_connectors_off ?? {})),
    'apps._default.enabled=false does not remove codex_apps': loaded('thread_apps_default_off', 'codex_apps'),
    'with no node_repl configured the same override is rejected (invalid transport)': /invalid transport/.test(
      o.no_node_repl_configured?.startError ?? '',
    ),
    'both switches together turn off both':
      has('thread_both_off', 'node_repl') && o.thread_both_off.node_repl === 0 && !('codex_apps' in o.thread_both_off),
  });
}
