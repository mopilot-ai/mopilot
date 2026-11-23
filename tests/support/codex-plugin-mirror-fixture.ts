// The plugin store mirrored into Codex (electron/plugins/codexMirror.cjs): one Codex marketplace per store
// marketplace over its install folders, installs that follow the store (new, upgraded, removed), plugins Codex
// already has left to it, failures recorded per plugin, and threads switched off while plugins.codex is off. The
// fake app-server behaves as codex-cli 0.162 did against a scratch CODEX_HOME. Data is made up.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { CodexPluginMirror, codexId, codexMarketplace } = require('../../electron/plugins/codexMirror.cjs');
const { PluginStore } = require('../../electron/plugins/store.cjs');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'mopilot-codex-mirror-'));
const write = (file: string, text: string) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
};
function plugin(name: string, version = '1.0.0') {
  const root = path.join(tmp(), name);
  write(path.join(root, '.claude-plugin/plugin.json'), JSON.stringify({ name, version }));
  write(path.join(root, `skills/${name}-skill/SKILL.md`), `---\nname: ${name}-skill\n---\n`);
  return root;
}
async function install(store: any, src: string, marketplace = 'acme') {
  const p = await store.preview(src);
  return (await store.install(src, { marketplace, trust: p.trust })).record;
}

/** A Codex app-server: marketplaces registered by path, plugins installed per marketplace, and a native one. */
function fakeCodex() {
  // Codex reports paths with links followed (/var → /private/var on macOS), as codex-cli 0.162 did
  const markets = new Map<string, { root: string; installed: Set<string> }>();
  const extra: any[] = [];
  const calls: [string, any][] = [];
  const fail: Record<string, string> = {};
  const native = {
    name: 'openai-curated',
    path: '/codex/curated.json',
    plugins: [{ id: 'stripe@openai-curated', name: 'stripe', installed: true, enabled: true }],
  };
  const manifestOf = (root: string) => JSON.parse(fs.readFileSync(path.join(root, '.agents/plugins/marketplace.json'), 'utf8'));
  const request = async (method: string, params: any) => {
    calls.push([method, params]);
    if (fail[method]) throw new Error(fail[method]);
    if (method === 'plugin/list') {
      const ours = [...markets].map(([name, m]) => {
        const names = new Set([...manifestOf(m.root).plugins.map((e: any) => e.name), ...m.installed]);
        return {
          name,
          path: path.join(fs.realpathSync(m.root), '.agents/plugins/marketplace.json'),
          plugins: [...names].map((n) => ({ id: `${n}@${name}`, name: n, installed: m.installed.has(n), enabled: true })),
        };
      });
      return { marketplaces: [native, { name: 'nameless', path: null, plugins: null }, ...extra, ...ours] };
    }
    if (method === 'marketplace/add') {
      const name = manifestOf(params.source).name;
      markets.set(name, { root: params.source, installed: new Set() });
      return { marketplaceName: name, installedRoot: fs.realpathSync(params.source), alreadyAdded: false };
    }
    if (method === 'plugin/install') {
      const m = [...markets.values()].find(
        (x) => path.join(fs.realpathSync(x.root), '.agents/plugins/marketplace.json') === params.marketplacePath,
      );
      if (!m) throw new Error('unknown marketplace');
      m.installed.add(params.pluginName);
      return { authPolicy: 'ON_INSTALL', appsNeedingAuth: [] };
    }
    if (method === 'plugin/uninstall') {
      const [name, mkt] = params.pluginId.split('@');
      markets.get(mkt)?.installed.delete(name);
      return {};
    }
    if (method === 'marketplace/remove') {
      markets.delete(params.marketplaceName);
      return {};
    }
    throw new Error(`unexpected ${method}`);
  };
  return { markets, calls, fail, request, native, extra };
}

function setup(o: { enabled?: () => boolean } = {}) {
  const dir = tmp();
  const store = new PluginStore({ dir: () => dir });
  const codex = fakeCodex();
  const logs: string[] = [];
  const mirror = new CodexPluginMirror({
    store,
    request: codex.request,
    connected: () => true,
    enabled: o.enabled,
    log: (l: string) => logs.push(l),
  });
  const methods = () => codex.calls.map(([m]) => m);
  return { dir, store, codex, mirror, logs, methods };
}

export { test, assert, fs, path, tmp, write, plugin, install, setup, fakeCodex, CodexPluginMirror, PluginStore, codexId, codexMarketplace };
