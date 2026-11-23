// Settings → Connections: the optional built-in connectors and the macOS Quick Actions (pages/settings/Integrations.tsx),
// over a fake native bridge. Both start off, and only the user's switch installs anything.
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { window } from './support/dom.ts';
import * as React from 'react';
import { stubStore } from './support/stubs.ts';
import { installNativeStub } from './support/ports/native.ts';

const { act, createElement } = React;
const f: any = {
  gate: null as Promise<void> | null,
  calls: [] as any[][],
  connectors: [] as any[],
  status: { state: 'off', installed: 0, total: 3 } as any,
  fail: null as string | null,
};
installNativeStub({
  plugins: {
    builtin: {
      list: async () => {
        f.calls.push(['connectors.list']);
        await f.gate;
        if (f.broken) throw new Error('unreadable');
        return f.connectors;
      },
      set: async (id: string, on: boolean) => {
        f.calls.push(['connectors.set', id, on]);
        if (f.fail) throw f.raw ? f.fail : new Error(f.fail);
        f.connectors = f.connectors.map((c: any) => (c.id === id ? { ...c, state: on ? 'on' : 'off' } : c));
        return f.connectors;
      },
    },
  },
  app: {
    quickActions: {
      status: async () => {
        f.calls.push(['quickActions.status']);
        await f.gate;
        if (f.broken) throw new Error('unreadable');
        return f.status;
      },
      set: async (on: boolean) => {
        f.calls.push(['quickActions.set', on]);
        if (f.fail) throw f.raw ? f.fail : new Error(f.fail);
        f.status = { state: on ? 'on' : 'off', installed: on ? 3 : 0, total: 3 };
        return f.status;
      },
    },
  },
});
stubStore({ toast: (...a: unknown[]) => f.calls.push(['toast', ...a]) });
await import('../src/lib/native/contracts/builtinConnectors.ts');
await import('../src/lib/native/contracts/quickActions.ts');
const { createRoot } = await import('react-dom/client');
const { BuiltinConnectors, QuickActions } = await import('../src/components/pages/settings/Integrations.tsx');

let root: ReturnType<typeof createRoot> | null = null;
let container: HTMLElement;
async function render(el: React.ReactElement) {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root!.render(el));
  await act(async () => void (await new Promise((r) => setTimeout(r, 5))));
}
afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = null;
  container?.remove();
  f.calls = [];
  f.fail = null;
  f.raw = false;
  f.broken = false;
  f.gate = null;
  f.connectors = [];
  f.status = { state: 'off', installed: 0, total: 3 };
});
const click = (el: Element) => act(async () => void el.dispatchEvent(new window.MouseEvent('click', { bubbles: true }) as any));
const settle = () => act(async () => void (await new Promise((r) => setTimeout(r, 5))));
const github = {
  id: 'github',
  title: 'GitHub',
  description: 'GitHub’s official MCP server, signed in with your gh login.',
  version: '2.0.3',
  state: 'off',
};

test('connectors: GitHub is off until its switch is turned on, then on for every harness; turning it off removes it', async () => {
  f.connectors = [github];
  await render(createElement(BuiltinConnectors));
  assert.match(container.textContent!, /Built-in connectors/);
  assert.match(container.textContent!, /Version 2\.0\.3/);
  const sw = () => container.querySelector('button[role="switch"]') as HTMLButtonElement;
  assert.equal(sw().getAttribute('aria-checked'), 'false');
  await click(sw());
  await settle();
  assert.deepEqual(
    f.calls.filter((c: any[]) => c[0] === 'connectors.set'),
    [['connectors.set', 'github', true]],
  );
  assert.equal(sw().getAttribute('aria-checked'), 'true');
  await click(sw());
  await settle();
  assert.equal(sw().getAttribute('aria-checked'), 'false');
});

test('connectors: a failure is told, and the switch stays off', async () => {
  f.connectors = [github];
  f.fail = 'Sign in to GitHub first';
  await render(createElement(BuiltinConnectors));
  await click(container.querySelector('button[role="switch"]')!);
  await settle();
  assert.deepEqual(f.calls.at(-1), ['toast', 'Sign in to GitHub first', 'error']);
  assert.equal(container.querySelector('button[role="switch"]')!.getAttribute('aria-checked'), 'false');
});

test('connectors: a failure that is not an Error is told in its own words', async () => {
  f.connectors = [github];
  f.fail = 'offline';
  f.raw = true;
  await render(createElement(BuiltinConnectors));
  await click(container.querySelector('button[role="switch"]')!);
  await settle();
  assert.deepEqual(f.calls.at(-1), ['toast', 'offline', 'error']);
});

test('connectors: one that is unavailable says why and cannot be switched; none listed shows nothing', async () => {
  f.connectors = [{ ...github, state: 'unavailable', why: 'Not available on this computer yet' }];
  await render(createElement(BuiltinConnectors));
  assert.match(container.textContent!, /Not available on this computer yet/);
  assert.equal((container.querySelector('button[role="switch"]') as HTMLButtonElement).disabled, true);
  await act(async () => root!.unmount());
  root = null;
  container.remove();
  f.connectors = [];
  await render(createElement(BuiltinConnectors));
  assert.equal(container.textContent, '');
});

test('connectors: a list that cannot be read shows nothing', async () => {
  f.broken = true;
  await render(createElement(BuiltinConnectors));
  assert.equal(container.textContent, '');
});

test('quick actions: off until switched on; on writes them, off removes them', async () => {
  await render(createElement(QuickActions));
  assert.match(container.textContent!, /Quick Actions/);
  const sw = () => container.querySelector('button[role="switch"]') as HTMLButtonElement;
  assert.equal(sw().getAttribute('aria-checked'), 'false');
  assert.deepEqual(
    f.calls.filter((c: any[]) => c[0] === 'quickActions.set'),
    [],
  );
  await click(sw());
  await settle();
  assert.deepEqual(
    f.calls.filter((c: any[]) => c[0] === 'quickActions.set'),
    [['quickActions.set', true]],
  );
  assert.equal(sw().getAttribute('aria-checked'), 'true');
  await click(sw());
  await settle();
  assert.equal(sw().getAttribute('aria-checked'), 'false');
});

test('quick actions: stale ones show as on with the hint to turn them on again; a failure is told', async () => {
  f.status = { state: 'stale', installed: 2, total: 3 };
  await render(createElement(QuickActions));
  assert.match(container.textContent!, /Out of date\. Turn off and on to update/);
  assert.equal(container.querySelector('button[role="switch"]')!.getAttribute('aria-checked'), 'true');
  f.fail = 'already in Services';
  await click(container.querySelector('button[role="switch"]')!);
  await settle();
  assert.deepEqual(f.calls.at(-1), ['toast', 'already in Services', 'error']);
});

test('quick actions: not offered where they cannot be installed, nor when the status cannot be read', async () => {
  f.status = { state: 'unavailable', installed: 0, total: 3 };
  await render(createElement(QuickActions));
  assert.equal(container.textContent, '');
  await act(async () => root!.unmount());
  root = null;
  container.remove();
  f.broken = true;
  await render(createElement(QuickActions));
  assert.equal(container.textContent, '');
});

test('both ignore a late answer, or a late failure, after they are gone', async () => {
  for (const broken of [false, true]) {
    f.broken = broken;
    f.connectors = [github];
    let open: () => void = () => {};
    f.gate = new Promise<void>((r) => (open = r));
    for (const el of [BuiltinConnectors, QuickActions]) {
      f.calls = [];
      await render(createElement(el));
      await act(async () => root!.unmount());
      root = null;
      container.remove();
      open();
      await settle();
      assert.deepEqual(
        f.calls.filter((c: any[]) => c[0] === 'toast'),
        [],
      );
      f.gate = new Promise<void>((r) => (open = r));
    }
    f.gate = null;
  }
});
