// Session card options retain user choices locally, list the selected harness's actual model catalog and never alter the parent.
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import './support/dom.ts';
import { fakeStore, render } from './support/pages-kit.ts';
import { stubStore } from './support/stubs.ts';
const { createElement: h, useState, act } = await import('react');
const store = fakeStore<any>({
  basicHarnesses: [
    { id: 'kimi', label: 'Kimi Code', state: 'admitted' },
    { id: 'custom', state: 'admitted' },
    { id: 'blocked', state: 'blocked' },
  ],
});
const models: Record<string, any[]> = {
  codex: [
    { id: 'one', label: 'Model one', efforts: ['low', 'high'] },
    { id: 'two', label: 'Model two', efforts: ['low'] },
  ],
  claude: [],
};
let kind = 'codex';
let permission: string | null = 'default';
stubStore({ useStore: store.useStore, chatKind: () => kind });
mock.module('../src/lib/flags.ts', { namedExports: { useEnabledHarnesses: () => ['codex', 'claude'] } });
mock.module('../src/session/harness/select.ts', {
  namedExports: {
    useHarnessModels: (harness: string) => models[harness],
    useEffectiveSelection: (harness: string) => ({ model: models[harness][0] ?? null }),
  },
});
mock.module('../src/store/session/useSession.ts', {
  namedExports: {
    flushSessionPatches: () => {},
    useSession: () => ({ permission }),
    useSessionField: (id: any, pick: any) => pick(((() => ({ permission })) as (id: any) => any)(id)),
  },
});
const { StartOptions, startChoice } = await import('../src/components/thread/StartOptions.tsx');
const proposal = { parentId: 'parent', place: 'worktree' } as any;
const changes: any[] = [];
function Host() {
  const [choice, setChoice] = useState({ harness: null, useWorktree: null });
  return h(StartOptions, {
    proposal,
    choice,
    onChange: (next: any) => {
      changes.push(next);
      setChoice(next);
    },
  });
}
const choose = (host: ParentNode, label: string, value: string) =>
  act(async () => {
    const select = host.querySelector(`[aria-label="${label}"]`) as HTMLSelectElement;
    select.value = value;
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });

test('model, effort and permission pickers send only user changes and reset stale model choices on a harness change', async () => {
  changes.length = 0;
  kind = 'codex';
  permission = 'default';
  const v = await render(h(Host));
  const model = v.host.querySelector('[aria-label="Session model"]') as HTMLSelectElement;
  assert.deepEqual(
    [...model.options].map((o) => o.textContent),
    ['As proposed', 'Model one', 'Model two'],
  );
  const modes = v.host.querySelector('[aria-label="Session permissions"]') as HTMLSelectElement;
  assert.deepEqual(
    [...modes.options].map((o) => o.value),
    ['', 'read-only', 'default'],
  );
  await choose(v.host, 'Session effort', 'high');
  await choose(v.host, 'Session permissions', 'read-only');
  await choose(v.host, 'Session model', 'two');
  assert.deepEqual(startChoice(changes.at(-1)), { model: 'two', permission: 'read-only' });
  assert.deepEqual(
    [...(v.host.querySelector('[aria-label="Session effort"]') as HTMLSelectElement).options].map((o) => o.value),
    ['', 'low'],
  );
  await choose(v.host, 'Session effort', 'low');
  assert.deepEqual(startChoice(changes.at(-1)), { model: 'two', effort: 'low', permission: 'read-only' });
  await choose(v.host, 'Session effort', '');
  await choose(v.host, 'Session permissions', '');
  await choose(v.host, 'Session model', '');
  assert.equal(startChoice(changes.at(-1)), null);
  const harness = v.host.querySelector('select') as HTMLSelectElement;
  assert.deepEqual(
    [...harness.options].map((o) => o.textContent),
    ['As proposed', 'Codex', 'Claude Code', 'Kimi Code', 'custom'],
  );
  await act(async () => {
    harness.value = 'claude';
    harness.dispatchEvent(new Event('change', { bubbles: true }));
  });
  assert.deepEqual(startChoice(changes.at(-1)), { harness: 'claude' });
  assert.equal((v.host.querySelector('[aria-label="Session model"]') as HTMLSelectElement).disabled, true);
  assert.match(v.host.textContent ?? '', /Models are unavailable/);
  await v.unmount();
});

test('unsupported catalogs stay explicit, and an unknown parent permission offers inheritance only', async () => {
  kind = 'acp:kimi';
  permission = null;
  const basic = await render(h(Host));
  assert.match(basic.host.textContent ?? '', /This harness sets its own model, effort and permissions/);
  assert.equal((basic.host.querySelector('[aria-label="Session model"]') as HTMLSelectElement).disabled, true);
  assert.equal(basic.host.querySelector('[aria-label="Session model"]')?.textContent, 'Set by harness');
  await basic.unmount();
  kind = 'claude';
  const empty = await render(h(Host));
  assert.equal((empty.host.querySelector('[aria-label="Session effort"]') as HTMLSelectElement).disabled, true);
  assert.equal((empty.host.querySelector('[aria-label="Session permissions"]') as HTMLSelectElement).disabled, true);
  assert.match(empty.host.textContent ?? '', /Permissions are inherited/);
  await empty.unmount();
});

test('catalog and permission changes retain unavailable choices visibly, and clearing them restores inheritance', async () => {
  kind = 'codex';
  permission = 'default';
  const original = models.codex;
  const v = await render(h(Host));
  try {
    await choose(v.host, 'Session model', 'one');
    await choose(v.host, 'Session effort', 'high');
    await choose(v.host, 'Session permissions', 'default');
    models.codex = [];
    permission = 'read-only';
    await v.rerender(h(Host));
    for (const [label, value] of [
      ['model', 'one'],
      ['effort', 'high'],
      ['permissions', 'default'],
    ]) {
      const control = v.host.querySelector(`[aria-label="Session ${label}"]`) as HTMLSelectElement;
      assert.equal(control.value, value);
      assert.equal(control.disabled, false, 'the user can clear a choice even after the catalog becomes empty');
      assert.equal(control.selectedOptions[0].textContent, `${value} (unavailable)`);
    }
    await choose(v.host, 'Session model', '');
    await choose(v.host, 'Session permissions', '');
    assert.equal(startChoice(changes.at(-1)), null);
  } finally {
    models.codex = original;
    permission = 'default';
    await v.unmount();
  }
});

test('actual native permission values expose bounded app choices and planning inherits without offering an invalid higher scope', async () => {
  kind = 'claude';
  for (const [native, expected] of [
    ['bypassPermissions', 4],
    ['auto', 3],
    ['acceptEdits', 2],
    ['dontAsk', 1],
    ['plan', 0],
    ['unknown', 0],
  ] as const) {
    permission = native;
    const v = await render(h(Host));
    try {
      const select = v.host.querySelector('[aria-label="Session permissions"]') as HTMLSelectElement;
      assert.equal(select.options.length, Number(expected) + 1, String(native));
      assert.equal(select.disabled, expected === 0);
    } finally {
      await v.unmount();
    }
  }
  kind = 'codex';
  permission = 'default';
});

test('a native planned parent exposes inheritance only and that actual card choice retains main plan restrictions', async () => {
  const { createRequire } = await import('node:module');
  const { createChildOptions } = createRequire(import.meta.url)('../electron/session/orchestration/childSetup.cjs');
  kind = 'claude';
  permission = 'plan';
  const v = await render(h(Host));
  try {
    const control = v.host.querySelector('[aria-label="Session permissions"]') as HTMLSelectElement;
    assert.equal(control.disabled, true);
    assert.equal(control.value, '');
    const selected = startChoice({ harness: null, useWorktree: null });
    const live = {
      controller: { ref: () => ({ kind: 'claude' }), state: { get: () => ({ plan: true, permission: 'plan' }) } },
      chats: { records: new Map([['parent', { meta: { config: {} } }]]) },
      claudeTurns: { settings: () => ({ permission: 'full-access', model: 'opus', effort: 'high' }) },
    };
    const inherited = await createChildOptions({ live, prefs: () => ({ permission: 'full-access' }) })('parent', 'claude', selected ?? {});
    assert.equal(inherited.permission, 'plan');
    assert.match(v.host.textContent ?? '', /follow the parent’s plan mode/);
  } finally {
    await v.unmount();
    kind = 'codex';
    permission = 'default';
  }
});
