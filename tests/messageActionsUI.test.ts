// Direct response rating controls retain only the latest selection across overlapping requests and owner changes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { h, render, settle, impl, callsTo, setStore, clipboard } from './support/thread-view/fixture.ts';
import { deferred } from './support/async-scenarios.ts';
import { readAppCssPart } from './support/app-css.ts';

const { MessageActions } = await import('../src/components/thread/view/MessageActions.tsx');
const actions = (threadId = 'chat', turnId = 'turn') => h(MessageActions, { text: 'Answer', threadId, turnId });

test('copying a heartbeat answer keeps the report Markdown and omits its delivery envelope', async () => {
  const report = 'Finished **two** changes.\n\n[Report](/tmp/report.json)';
  const raw = `<heartbeat><automation_id>daily</automation_id><decision>NOTIFY</decision><message>${report}</message></heartbeat>`;
  const v = await render(h(MessageActions, { text: raw, threadId: 'chat', turnId: 'turn' }));
  await settle(() => v.$('[aria-label="Copy"]')!.click());
  assert.equal(clipboard.at(-1), report);
  await v.unmount();
});

test('the selected rating is visibly highlighted', async () => {
  impl['chat:rateReply'] = async () => true;
  const style = document.createElement('style');
  style.textContent =
    ':root { --text-3: #666666; --text-ui: #eeeeee; }' + readAppCssPart('app/sidebar.css') + readAppCssPart('app/thread-messages.css');
  document.head.append(style);
  try {
    const v = await render(actions());
    const good = v.$('[aria-label="Good response"]')!;
    const bad = v.$('[aria-label="Bad response"]')!;
    assert.equal(getComputedStyle(good).color, '#666666');
    await settle(() => good.click());
    assert.equal(getComputedStyle(good).color, '#eeeeee');
    assert.equal(getComputedStyle(bad).color, '#666666');
    await settle(() => bad.click());
    assert.equal(getComputedStyle(good).color, '#666666');
    assert.equal(getComputedStyle(bad).color, '#eeeeee');
    await v.unmount();
  } finally {
    style.remove();
  }
});

for (const olderSucceeds of [false, true]) {
  for (const latestSucceeds of [false, true]) {
    for (const olderFirst of [false, true]) {
      test(`direct ratings keep the latest result: older=${olderSucceeds}, latest=${latestSucceeds}, olderFirst=${olderFirst}`, async () => {
        const older = deferred<boolean>();
        const latest = deferred<boolean>();
        impl['chat:rateReply'] = (_chatId, kind) => (kind === 'good' ? older.promise : latest.promise);
        const v = await render(actions());
        const good = v.$('[aria-label="Good response"]')!;
        const bad = v.$('[aria-label="Bad response"]')!;
        await settle(() => good.click());
        assert.equal(good.getAttribute('aria-pressed'), 'true');
        await settle(() => bad.click());
        assert.equal(good.getAttribute('aria-pressed'), 'false');
        assert.equal(bad.getAttribute('aria-pressed'), 'true');
        if (olderFirst) {
          await settle(() => older.resolve(olderSucceeds));
          assert.equal(bad.getAttribute('aria-pressed'), 'true', 'the older completion cannot clear a pending selection');
          await settle(() => latest.resolve(latestSucceeds));
        } else {
          await settle(() => latest.resolve(latestSucceeds));
          assert.equal(bad.getAttribute('aria-pressed'), String(latestSucceeds));
          await settle(() => older.resolve(olderSucceeds));
        }
        assert.deepEqual(callsTo('chat:rateReply'), [
          ['chat', 'good'],
          ['chat', 'bad'],
        ]);
        assert.equal(good.getAttribute('aria-pressed'), 'false');
        assert.equal(bad.getAttribute('aria-pressed'), String(latestSucceeds));
        await v.unmount();
      });
    }
  }
}

for (const change of ['chat', 'turn', 'unmount'] as const) {
  test(`a ${change} change retires the old selection and its pending failure`, async () => {
    const retired = deferred<boolean>();
    const current = deferred<boolean>();
    impl['chat:rateReply'] = (_chatId, kind) => (kind === 'good' ? retired.promise : current.promise);
    let v = await render(actions());
    await settle(() => v.$('[aria-label="Good response"]')!.click());
    if (change === 'unmount') {
      await v.unmount();
      v = await render(actions());
    } else {
      await v.rerender(actions(change === 'chat' ? 'other' : 'chat', change === 'turn' ? 'other' : 'turn'));
    }
    assert.equal(v.$('[aria-label="Good response"]')!.getAttribute('aria-pressed'), 'false');
    await settle(() => v.$('[aria-label="Bad response"]')!.click());
    assert.deepEqual(callsTo('chat:rateReply').at(-1), [change === 'chat' ? 'other' : 'chat', 'bad']);
    await settle(() => retired.resolve(false));
    assert.equal(v.$('[aria-label="Bad response"]')!.getAttribute('aria-pressed'), 'true');
    await settle(() => current.resolve(true));
    assert.equal(v.$('[aria-label="Bad response"]')!.getAttribute('aria-pressed'), 'true');
    await v.unmount();
  });
}

test('the thumbs stay on with usage data sharing off: the click is the consent to send the rating', async () => {
  impl['chat:rateReply'] = async () => true;
  setStore({ prefs: { shareUsageData: false } });
  const v = await render(actions());
  const good = v.$('[aria-label="Good response"]') as HTMLButtonElement;
  assert.equal(good.disabled, false);
  assert.equal(good.parentElement!.dataset.tooltip, 'Good response');
  await settle(() => good.click());
  assert.deepEqual(callsTo('chat:rateReply').at(-1), ['chat', 'good']);
  assert.equal(good.getAttribute('aria-pressed'), 'true');
  await v.unmount();
});
