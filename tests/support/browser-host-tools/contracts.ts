// Browser tool contracts, registration and live enablement.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { browserToolSpecs, registerBrowserTools, BROWSER_TOOL_NAMES, STATE, world, texts, code } from './fixture';

export function registerContractsCases() {
  // ---------------------------------------------------------------- specs and registration

  test('the browser specs list every tool with its policy', () => {
    const specs = browserToolSpecs();
    assert.deepEqual(
      specs.map((s: any) => s.name),
      BROWSER_TOOL_NAMES,
    );
    assert.equal(specs.length, 33);
    const nav = specs.find((s: any) => s.name === 'browser_navigate');
    assert.equal(nav.policy, 'observe');
    assert.deepEqual(nav.inputSchema.required, ['url']);
    assert.equal(specs.find((s: any) => s.name === 'browser_computer').policy, 'act');
  });

  test('createBrowserTools returns self-authorizing tools matching the specs', () => {
    const { tools } = world();
    const specs = browserToolSpecs();
    assert.deepEqual(
      tools.map((t: any) => t.name),
      BROWSER_TOOL_NAMES,
    );
    for (const t of tools) {
      const s = specs.find((x: any) => x.name === t.name);
      assert.equal(t.authorizesItself, true);
      assert.equal(t.policy, s.policy);
      assert.equal(t.description, s.description);
      assert.deepEqual(t.schema, s.inputSchema);
      assert.equal(typeof t.handler, 'function');
    }
  });

  test('registerBrowserTools registers every tool and the returned function removes them all', () => {
    const registered = new Map<string, any>();
    const registry = {
      register(t: any) {
        registered.set(t.name, t);
        return () => registered.delete(t.name);
      },
    };
    const w = world();
    // a chat's browser_script session ends with its turn, and every session when the tools go
    const listeners = new Set<(chatId: string) => void>();
    w.tabs.onTurnEnd = (fn: any) => (listeners.add(fn), () => listeners.delete(fn));
    const ended: string[] = [];
    const sessions = { end: (chatId: string) => ended.push(chatId), endAll: () => ended.push('*') };
    // the page trees the model read are forgotten with the turn too
    const snapshots = { reset: (chatId: string) => ended.push(`reset ${chatId}`) };
    const off = registerBrowserTools(registry, { tabs: w.tabs, grants: w.grants, sessions, snapshots });
    assert.deepEqual([...registered.keys()], BROWSER_TOOL_NAMES);
    for (const fn of listeners) fn('c1');
    off();
    assert.equal(registered.size, 0);
    assert.equal(listeners.size, 0);
    assert.deepEqual(ended, ['c1', 'reset c1', '*']);
    // its own sessions when none are given
    w.tabs.onTurnEnd = () => () => {};
    registerBrowserTools(registry, { tabs: w.tabs, grants: w.grants })();
  });

  test('browser_batch description is name-agnostic (no "browser_*" wildcard)', () => {
    const desc = browserToolSpecs().find((s: any) => s.name === 'browser_batch').description;
    assert.doesNotMatch(desc, /browser_\*/);
    assert.match(desc, /navigate/);
    assert.match(desc, /"browser_" prefix is also accepted/);
  });

  // ---------------------------------------------------------------- enabled()

  test('enabled(): a string refuses with that message, false with the default one, checked on every call', async () => {
    let on: any = 'Browser control is paused.';
    const w = world({ enabled: () => on });
    await assert.rejects(w.call('browser_tabs_close', { tabId: 't1' }), code('disabled', /^Browser control is paused\.$/));
    on = false;
    await assert.rejects(w.call('browser_tabs_close', { tabId: 't1' }), code('disabled', /^Browser control is turned off\.$/));
    assert.equal(w.tabs.called('close').length, 0);
    on = true;
    const out = await w.call('browser_tabs_close', { tabId: 't1' });
    assert.deepEqual(texts(out), ['Closed tab t1.', STATE]);
  });
}
