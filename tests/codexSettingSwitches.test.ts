// Codex's MCP, app and skill switches with the real Toggle: a click while the list is being read again is not taken,
// and the click after the re-read writes the other value (the double `enabled = false` behind #1461).
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import './support/dom.ts';
import { mount, click, flush, popoverStubs, iconStubs } from './support/harness-ui-kit.ts';
import { installNativeStub } from './support/ports/native.ts';
import { stubStore } from './support/stubs.ts';

const { createElement: h, useState } = await import('react');
const writes: unknown[] = [];
const toasts: unknown[] = [];
stubStore({ toast: (...a: unknown[]) => void toasts.push(a) });
mock.module('../src/harness/adapters/codex.ts', {
  namedExports: {
    onCodexNotification: () => () => {},
    codexRequest: async (method: string, params: any) => {
      if (method === 'config/value/write') writes.push([params.keyPath, params.value]);
      if (method === 'skills/config/write') writes.push([params.path, params.enabled]);
      return {};
    },
  },
});
installNativeStub({});
mock.module('../src/components/ui/Popover.tsx', { namedExports: popoverStubs });
mock.module('../src/components/ui/icons.tsx', {
  namedExports: { ...iconStubs(), Spinner: () => h('span'), Workflow: () => h('span') },
});
mock.module('../src/components/harness/codex/Plugins.tsx', {
  namedExports: {
    usePlugins: () => null,
    loadPlugins: async () => {},
    PluginLogo: () => h('span'),
    nameOf: (p: any) => p.name,
    BUNDLED: new Set(),
    openPlugin: () => {},
    toggleInstalled: async () => {},
  },
});

const { McpList } = await import('../src/components/harness/codex/pluginSettings/McpServers.tsx');
const { AppItem, SkillItem } = await import('../src/components/harness/codex/pluginSettings/rows.tsx');

/** A list whose re-read waits for `release`, then shows `on`. */
function held() {
  let release: () => void = () => {};
  function List({ render }: { render: (on: boolean, reread: () => Promise<void>) => any }) {
    const [on, setOn] = useState(true);
    const reread = (next: boolean) => () => new Promise<void>((resolve) => (release = () => (setOn(next), resolve())));
    return render(on, reread(!on));
  }
  return { List, release: () => release() };
}

const cases = {
  mcp: (on: boolean, reread: () => Promise<void>) =>
    h(McpList, {
      status: [],
      servers: { own: { command: 'run', enabled: on } },
      match: () => true,
      onEdit: () => {},
      onChange: reread,
    }),
  app: (on: boolean, reread: () => Promise<void>) => h(AppItem, { app: { id: 'a1', name: 'A', isEnabled: on } as any, onChange: reread }),
  skill: (on: boolean, reread: () => Promise<void>) =>
    h(SkillItem, { s: { name: 'deploy', path: '/s/deploy', enabled: on, scope: 'user' } as any, onChange: reread }),
};
const key = { mcp: 'mcp_servers."own".enabled', app: 'apps."a1".enabled', skill: '/s/deploy' };

for (const [kind, render] of Object.entries(cases) as [keyof typeof cases, (typeof cases)['mcp']][]) {
  test(`${kind}: the switch holds the value being written until the re-read, and the next click writes the other`, async () => {
    writes.length = 0;
    const list = held();
    const r = await mount(h(list.List, { render }));
    const sw = () => r.host.querySelector('[role=switch]') as HTMLButtonElement;
    await click(sw());
    await flush();
    assert.equal(sw().getAttribute('aria-checked'), 'false');
    assert.equal(sw().getAttribute('aria-busy'), 'true');
    // a second click before the re-read lands is not taken: it would have written `false` again
    await click(sw());
    await flush();
    assert.deepEqual(writes, [[key[kind], false]]);
    list.release();
    await flush();
    assert.equal(sw().getAttribute('aria-busy'), null);
    await click(sw());
    await flush();
    list.release();
    await flush();
    assert.deepEqual(writes, [
      [key[kind], false],
      [key[kind], true],
    ]);
    assert.equal(sw().getAttribute('aria-checked'), 'true');
    assert.deepEqual(toasts, []);
    await r.unmount();
  });
}
