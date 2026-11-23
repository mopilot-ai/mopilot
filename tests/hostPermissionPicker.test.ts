// Machine permission controls use only Host anchors and keep choices in their own draft/chat, never Mac defaults.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import './support/dom.ts';
import { $, $$, click, mount } from './support/composer-kit.ts';
import { mockSource } from './support/stubs.ts';
let state: any = {};
let told: any = null;
const changes: any[] = [];
mockSource('src/store/core.ts', {
  useStore: (f: any) => f(state),
  toast: () => {},
  set: (p: any) => Object.assign(state, typeof p === 'function' ? p(state) : p),
});
mockSource('src/store/projects.ts', {
  setChatConfig: (id: string, p: any) => {
    changes.push([id, p]);
    state.chatConfig[id] = { ...state.chatConfig[id], ...p };
  },
});
mockSource('src/lib/hostMachines.ts', { useHostMachines: () => ({ machines: [] }) });
mockSource('src/session/open.ts', { openLink: () => {} });
mockSource('src/store/session/useSession.ts', { useSessionField: (_: any, f: any) => f({ permission: told }) });
const { createElement: h, act } = await import('react');
const { HostPermissionPicker } = await import('../src/components/composer/HostPermissionPicker.tsx');
const open = () => click($('[aria-label="Change permissions"]'));
function reset() {
  state = { newChatHost: { id: 'box', name: 'Box', path: '/there' }, chatConfig: {}, prefs: { permission: 'full-access' } };
  told = null;
  changes.length = 0;
}
test('each Host family offers exactly four anchors; draft choice never changes this Mac defaults', async () => {
  for (const family of ['claude', 'codex'] as const) {
    reset();
    const m = await mount(h(HostPermissionPicker, { threadId: null, family, hostId: 'box' }));
    try {
      // nothing picked for the machine: it shows this Mac's default (#5403), which a pick here never changes
      assert.match(m.host.textContent!, /Full access/);
      await open();
      assert.equal($$('[role=menuitemradio]').length, 4);
      assert.match($('.perm-menu-head')!.textContent!, /Learn more/, 'the menu head links to the docs, as on This Mac');
      await click($$('[role=menuitemradio]')[0]);
      assert.equal(state.newChatHost.permission?.value, 'read-only');
      assert.equal(state.prefs.permission, 'full-access');
      assert.deepEqual(changes, []);
      await m.render(h(HostPermissionPicker, { threadId: null, family, hostId: 'box' }));
      assert.match(m.host.textContent!, /Read-only/);
      await m.render(h(HostPermissionPicker, { threadId: null, family: family === 'claude' ? 'codex' : 'claude', hostId: 'box' }));
      assert.match(m.host.textContent!, /Full access/, "another harness does not inherit the draft pick: it shows this Mac's default");
      await open();
      state.newChatHost = { id: 'other' };
      await click($$('[role=menuitemradio]')[3]);
      assert.equal(state.newChatHost.permission, undefined);
    } finally {
      await m.unmount();
    }
  }
});
test('started chat reads its persisted machine choice or native snapshot and changes only that chat', async () => {
  reset();
  told = 'read-only';
  const m = await mount(h(HostPermissionPicker, { threadId: 'c', family: 'codex', hostId: 'box' }));
  try {
    assert.match(m.host.textContent!, /Read-only/);
    await open();
    await click($$('[role=menuitemradio]')[3]);
    assert.deepEqual(changes, [['c', { hostPermission: { hostId: 'box', harness: 'codex', value: 'full-access' } }]]);
    assert.equal(state.prefs.permission, 'full-access');
    await m.render(h(HostPermissionPicker, { threadId: 'c', family: 'codex', hostId: 'box' }));
    assert.match(m.host.textContent!, /Full access/);
    state.chatConfig.c.hostPermission.hostId = 'elsewhere';
    told = 'plan';
    await m.render(h(HostPermissionPicker, { threadId: 'c', family: 'codex', hostId: 'box' }));
    assert.match(m.host.textContent!, /Full access/, "a pick for another machine is not this one's: this Mac's default");
  } finally {
    await m.unmount();
  }
});

test('the permission shortcut opens only its own composer and ignores unsupported native Plan mode', async () => {
  reset();
  told = 'plan';
  const m = await mount(h(HostPermissionPicker, { threadId: 'c', family: 'claude', hostId: 'box' }));
  try {
    assert.match(m.host.textContent!, /Full access/, 'a native Plan is no anchor: this Mac default');
    m.host.setAttribute('data-composer-chat', 'c');
    m.host.setAttribute('data-composer-main', 'true');
    const other = document.createElement('div');
    document.body.append(other);
    await act(async () => other.dispatchEvent(new Event('open-permission-picker', { bubbles: true })));
    await m.render(h(HostPermissionPicker, { threadId: 'c', family: 'claude', hostId: 'box' }));
    assert.equal($$('[role=menuitemradio]').length, 0, 'a command from another composer is ignored');
    other.remove();
    await act(async () => window.dispatchEvent(new Event('open-permission-picker')));
    await m.render(h(HostPermissionPicker, { threadId: 'c', family: 'claude', hostId: 'box' }));
    assert.equal($$('[role=menuitemradio]').length, 4);
  } finally {
    await m.unmount();
  }
});

test('every normalized permission has its matching button and selected row on each Host family', async () => {
  for (const family of ['claude', 'codex'] as const) {
    for (const mode of ['default', 'read-only', 'auto-review', 'full-access']) {
      reset();
      told = mode;
      const m = await mount(h(HostPermissionPicker, { threadId: 'c', family, hostId: 'box' }));
      try {
        assert.ok(m.host.querySelector(`.perm-btn.${mode}`));
        await open();
        assert.equal($$('.perm-item[aria-checked="true"]').length, 1);
        assert.ok($(`.perm-item.${mode}[aria-checked="true"]`));
      } finally {
        await m.unmount();
      }
    }
  }
});
