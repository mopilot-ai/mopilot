// Settings › Voice: Automatic or one pinned dictation service, with the order Automatic uses or why none can dictate.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup, resetCtl, defaultState, useStore, ctl, render, row, pick, calls, flush, responses } from './support/settings-harness.ts';
await setup();
const { createElement } = await import('react');
const { Settings } = await import('../src/components/pages/Settings.tsx');
test('Automatic is a choice of its own: it names the services in order, or why none can dictate', async () => {
  resetCtl();
  useStore.setState(defaultState(), true);
  ctl.dictationEngine = 'local';
  responses['speech.options'] = {
    engine: 'local',
    chain: ['local', 'credits', 'other'],
    choices: [{ id: 'local', state: 'ready', reason: null }],
  };
  const m = await render(createElement(Settings, { section: 'voice' }));
  try {
    await flush();
    const engine = row(m.host, 'Dictation engine');
    assert.equal(engine.querySelector('.select-btn')!.textContent, 'Automatic');
    assert.match(
      engine.textContent ?? '',
      /Uses This Mac, then MoPilot credits, then other\. A chat whose harness has its own speech service uses that first/,
    );
    calls.length = 0;
    await pick(row(m.host, 'Dictation engine'), 'MoPilot credits');
    await pick(row(m.host, 'Dictation engine'), 'Automatic');
    assert.deepEqual(
      calls.filter((c) => c[0] === 'setPrefs'),
      [
        ['setPrefs', { dictationEngine: 'credits' }],
        ['setPrefs', { dictationEngine: null }],
      ],
    );
  } finally {
    await m.unmount();
  }
  responses['speech.options'] = {
    engine: null,
    chain: [],
    choices: [{ id: 'local', state: 'blocked', reason: 'Dictation is turned off in this app' }],
  };
  const none = await render(createElement(Settings, { section: 'voice' }));
  await flush();
  assert.match(row(none.host, 'Dictation engine').textContent ?? '', /Dictation is turned off in this app/);
  await none.unmount();
  useStore.setState({ prefs: { ...useStore.getState().prefs, dictationEngine: 'credits' } });
  responses['speech.options'] = { engine: 'credits', chain: ['credits'], choices: [{ id: 'credits', reason: 'Service unavailable' }] };
  const blocked = await render(createElement(Settings, { section: 'voice' }));
  assert.match(row(blocked.host, 'Dictation engine').textContent ?? '', /Service unavailable/);
  await blocked.unmount();
  delete responses['speech.options'];
});
