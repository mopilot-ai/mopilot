// "Approve for me" on a machine chat follows the selected model's supportsAutoMode like This Mac's menu: false disables it, true or not reported does not (audit L40).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import './support/dom.ts';
import { $, $$, click, mount } from './support/composer-kit.ts';
import { mockSource } from './support/stubs.ts';
import { machineModels } from '../shared/host/models.mjs';
const NO = "This model can't auto-approve · Switch model";
let state: any = {};
let machines: any[] = [];
const toasts: any[] = [];
const changes: any[] = [];
mockSource('src/store/core.ts', {
  useStore: (f: any) => f(state),
  set: (p: any) => Object.assign(state, typeof p === 'function' ? p(state) : p),
  toast: (...a: any[]) => void toasts.push(a),
});
mockSource('src/store/projects.ts', { setChatConfig: (id: string, p: any) => void changes.push([id, p]) });
mockSource('src/store/session/useSession.ts', { useSessionField: () => null });
mockSource('src/session/open.ts', { openLink: () => {} });
mockSource('src/lib/hostMachines.ts', { useHostMachines: () => ({ machines }) });
const { createElement: h } = await import('react');
const { HostPermissionPicker } = await import('../src/components/composer/HostPermissionPicker.tsx');
const models = machineModels([
  { id: 'opus', name: 'Opus', default: true, efforts: [], supportsAutoMode: false },
  { id: 'sonnet', name: 'Sonnet', default: false, efforts: [], supportsAutoMode: true },
  { id: 'old', name: 'Old', default: false, efforts: [] },
]);
const pick = (model: string) => ({ hostId: 'box', harness: 'claude', model, effort: null });
function setup(selection?: any, agents: any[] = [{ id: 'claude', models }]) {
  machines = [{ id: 'box', name: 'Box', agents }];
  state = { newChatHost: { id: 'box', name: 'Box', path: '/x', selection }, chatConfig: {}, prefs: {} };
  toasts.length = 0;
  changes.length = 0;
}
const auto = () => $('.perm-item.auto-review')!;
async function opened(threadId: string | null = null) {
  const m = await mount(h(HostPermissionPicker, { threadId, family: 'claude', hostId: 'box' }));
  await click($('[aria-label="Change permissions"]'));
  return m;
}

test('the validator carries supportsAutoMode through machineModels, false included', () => {
  assert.deepEqual(
    models.map((m) => m.supportsAutoMode),
    [false, true, undefined],
  );
});

test("a model that reports false disables Approve for me with This Mac's text; a click says why and changes nothing", async () => {
  setup(pick('opus'));
  const m = await opened();
  try {
    assert.equal(auto().getAttribute('aria-disabled'), 'true');
    assert.equal(auto().getAttribute('title'), NO);
    assert.ok(auto().classList.contains('disabled'));
    await click(auto());
    assert.deepEqual(toasts, [[NO]]);
    assert.equal(state.newChatHost.permission, undefined);
    assert.equal($$('[role=menuitemradio]').length, 4, 'the menu stays open and complete');
  } finally {
    await m.unmount();
  }
});

test('the default model decides when none is picked; true and not reported leave the row enabled and pickable', async () => {
  setup();
  const first = await opened();
  assert.equal(auto().getAttribute('aria-disabled'), 'true', 'the default model is Opus');
  await first.unmount();
  for (const model of ['sonnet', 'old']) {
    setup(pick(model));
    const m = await opened();
    try {
      assert.notEqual(auto().getAttribute('aria-disabled'), 'true');
      assert.equal(auto().getAttribute('title'), null);
      await click(auto());
      assert.equal(state.newChatHost.permission.value, 'auto-review');
    } finally {
      await m.unmount();
    }
  }
});

test('an older Host with no model list, another agent or an unlisted machine gates nothing; a started chat reads its own pick', async () => {
  for (const agents of [[{ id: 'claude' }], [{ id: 'codex', models }]]) {
    setup(pick('opus'), agents);
    const m = await opened();
    try {
      assert.notEqual(auto().getAttribute('aria-disabled'), 'true', 'no report, no gate');
    } finally {
      await m.unmount();
    }
  }
  setup();
  machines = [];
  const none = await opened();
  assert.notEqual(auto().getAttribute('aria-disabled'), 'true');
  await none.unmount();
  setup();
  state.chatConfig.c = { hostSelection: pick('opus') };
  const m = await opened('c');
  try {
    assert.equal(auto().getAttribute('aria-disabled'), 'true');
    await click(auto());
    assert.deepEqual(changes, []);
  } finally {
    await m.unmount();
  }
});
