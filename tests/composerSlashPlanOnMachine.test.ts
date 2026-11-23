// The slash menu's app Plan on a chat on a machine: off with the reason, typed /plan kept, an ACP agent's own Plan and Goal unaffected (#4278).
// and their submenus, Codex skills, a harness's command catalog, and a basic harness's commands.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import './support/dom.ts';
import { $, $$, mouse } from './support/composer-kit.ts';
import { fx, last, mountComposer, reset, settle, setSessionState, store } from './support/composer-setup.ts';
beforeEach(() => reset());
const _W = window as any;
const _titles = () => $$('.slash-panel .add-panel-title').map((x) => x.textContent);
const row = (title: string) => $$('.slash-panel .add-panel-item').find((x) => x.querySelector('.add-panel-title')!.textContent === title)!;
const desc = (title: string) => row(title).querySelector('.add-panel-desc')?.textContent;
async function pick(m: any, query: string, ...path: string[]) {
  await m.type('/' + query);
  for (const t of path) {
    await mouse(row(t), 'mousedown');
    await settle();
  }
}
const _heard = (name: string) => {
  const seen: any[] = [];
  window.addEventListener(name, (e: any) => seen.push(e.detail ?? true));
  return seen;
};

test('machine Plan slash menu is disabled and typed Plan retains its text with the reason', async () => {
  for (const threadId of [null, 't1']) {
    fx.location = { machine: 'box', pending: false };
    const m = await mountComposer({ threadId });
    try {
      await m.type('/plan');
      assert.equal(row('Plan mode').getAttribute('aria-disabled'), 'true');
      assert.match(desc('Plan mode')!, /not available|isn't available/);
      await m.key('Escape');
      await m.key('Enter');
      await settle();
      assert.equal(last('session'), undefined);
      assert.equal(last('send'), undefined);
      assert.match(last('toast')?.[1] ?? '', /Plan mode.*box/);
      assert.equal(m.text, '/plan');
      assert.ok(!$('.plan-chip'));
    } finally {
      await m.unmount();
    }
  }
});

test('a stored Plan stays shown on a machine nothing is known of (the send then carries it, and is refused if the Host cannot take it), and on this Mac as before', async () => {
  setSessionState('t1', { plan: true });
  fx.location = { machine: 'box', pending: false };
  const m = await mountComposer({ threadId: 't1' });
  try {
    // nothing is known of what the machine's Host takes: the chat's own Plan is not hidden, so a send cannot leave it unseen
    assert.ok($('.plan-chip'));
    await m.type('ordinary remote input');
    await m.key('Enter');
    await settle();
    assert.equal(last('send')?.[4]?.plan, true);
    fx.location = { machine: null, pending: false };
    await m.rerender();
    assert.ok($('.plan-chip'));
  } finally {
    await m.unmount();
  }
});

test('a local harness refusal keeps typed Plan input and does not set the session', async () => {
  fx.blocked.plan = 'Plan is unavailable for this harness';
  const m = await mountComposer({ threadId: 't1' });
  try {
    await m.type('/plan');
    await m.key('Escape');
    await m.key('Enter');
    await settle();
    assert.equal(last('session'), undefined);
    assert.match(last('toast')?.[1] ?? '', /Plan is unavailable/);
    assert.equal(m.text, '/plan');
  } finally {
    await m.unmount();
  }
});

test('the ACP app Plan row is disabled on a machine while agent passthrough commands stay independent', async () => {
  store.set({ basicOf: { k1: 'kimi' } });
  fx.location = { machine: 'box', pending: false };
  fx.acpRegistry = { menu: [{ name: 'plan', description: 'Plan mode', dispatch: 'ui' }] };
  const m = await mountComposer({ threadId: 'k1' });
  try {
    await m.type('/plan');
    assert.equal(row('/plan').getAttribute('aria-disabled'), 'true');
    await pick(m, 'plan', '/plan');
    assert.equal(last('session'), undefined);
    assert.equal(last('send'), undefined);
  } finally {
    await m.unmount();
  }
});

test('a remote ACP native Plan passthrough remains offered and reaches its own agent as text', async () => {
  store.set({ basicOf: { k1: 'kimi' } });
  fx.location = { machine: 'box', pending: false };
  fx.acpRegistry = { menu: [{ name: 'plan', description: 'Agent planning', dispatch: 'passthrough' }] };
  const m = await mountComposer({ threadId: 'k1' });
  try {
    await m.type('/plan');
    assert.equal(row('/plan').getAttribute('aria-disabled'), 'false');
    await pick(m, 'plan', '/plan');
    await m.key('Enter');
    await settle();
    assert.equal(last('session'), undefined);
    assert.match(last('send')?.[2] ?? '', /^\/plan/);
    assert.equal(last('send')?.[4]?.plan, false);
  } finally {
    await m.unmount();
  }
});

test('app Plan availability affects only its own command, with no reason leaving it enabled', async () => {
  const { planCommandOff } = await import('../src/components/composer/useComposerPlan.ts');
  assert.equal(planCommandOff({ name: 'plan', dispatch: 'ui' }, 'Not here'), 'Not here');
  assert.equal(planCommandOff({ name: 'plan', dispatch: 'ui' }, null), undefined);
  assert.equal(planCommandOff({ name: 'plan', dispatch: 'passthrough' }, 'Not here'), undefined);
  assert.equal(planCommandOff({ name: 'status', dispatch: 'ui' }, 'Not here'), undefined);
});

test('an ACP Goal row retains its existing availability independently of machine Plan', async () => {
  for (const why of [null, 'Goals are unavailable']) {
    store.set({ basicOf: { k1: 'kimi' } });
    fx.goalOff = why;
    fx.acpRegistry = { menu: [{ name: 'goal', description: 'Goal', dispatch: 'ui' }] };
    const m = await mountComposer({ threadId: 'k1' });
    try {
      await m.type('/goal');
      assert.equal(row('/goal').getAttribute('aria-disabled'), String(!!why));
    } finally {
      await m.unmount();
    }
  }
});
