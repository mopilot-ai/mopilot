// The mode a machine chat shows in its permission menu before anything was picked there is this Mac's default; a pick for the machine, and what the Host told, come first (#5403).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import './support/dom.ts';
import { $, $$, click, mount } from './support/composer-kit.ts';
import { mockSource } from './support/stubs.ts';

let state: any = {};
let told: string | null = null;
mockSource('src/store/core.ts', { useStore: (f: any) => f(state), set: () => {}, toast: () => {} });
mockSource('src/store/projects.ts', { setChatConfig: () => {} });
mockSource('src/store/session/useSession.ts', { useSessionField: () => told });
mockSource('src/session/open.ts', { openLink: () => {} });
mockSource('src/lib/hostMachines.ts', {
  useHostMachines: () => ({ machines: [{ id: 'box', name: 'Box', agents: [{ id: 'claude', models: [] }] }] }),
});
const { createElement: h } = await import('react');
const { HostPermissionPicker } = await import('../src/components/composer/HostPermissionPicker.tsx');

async function shown(over: any, told_: string | null = null, threadId: string | null = null) {
  told = told_;
  state = { newChatHost: { id: 'box', name: 'Box', path: '/x', ...over.host }, chatConfig: {}, prefs: { permission: over.prefs } };
  const m = await mount(h(HostPermissionPicker, { threadId, family: 'claude', hostId: 'box' }));
  try {
    await click($('[aria-label="Change permissions"]'));
    return $$('[role=menuitemradio]')
      .filter((el) => el.getAttribute('aria-checked') === 'true')
      .map((el) => el.className);
  } finally {
    await m.unmount();
  }
}

test('with nothing picked the menu shows this Mac default', async () => {
  assert.match((await shown({ prefs: 'full-access' }))[0], /full-access/);
  assert.match((await shown({ prefs: 'auto-review' }))[0], /auto-review/);
  assert.match((await shown({ prefs: undefined }))[0], /default/, 'no default set: Ask for approval');
});

test('a pick for the machine and what the Host told come before this Mac default', async () => {
  assert.match(
    (await shown({ prefs: 'full-access', host: { permission: { hostId: 'box', harness: 'claude', value: 'read-only' } } }))[0],
    /read-only/,
  );
  assert.match((await shown({ prefs: 'full-access' }, 'auto-review'))[0], /auto-review/);
});
