// The gave-up banner when a Codex copy keeps quitting as it starts (src/components/accounts/access.tsx CodexQuitBanner,
// src/components/harness/codex/QuitActions.tsx): it names the build and its source, offers Use another Codex (Settings →
// Codex → Advanced) and Copy crash output, and says when the copy is the user's own pick.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { setup, calls, resetCtl, defaultState, useStore, render, click, text, button, flush } from './support/settings-harness.ts';

await setup();
const { createElement: h } = await import('react');
const { AccountExpiredBanner } = await import('../src/components/accounts/Accounts.tsx');

beforeEach(() => {
  resetCtl();
  useStore.setState(defaultState(), true);
});

test("the gave-up banner names the copy that keeps quitting, offers another Codex and the crash output, and says when it is the user's pick", async () => {
  const copy = {
    path: '/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex',
    version: '0.163.0-alpha.10.2',
    via: 'app-bundle',
    from: 'ChatGPT.app',
  };
  useStore.setState({
    codexRestart: 'gaveUp',
    codexQuit: { copy, pinned: false },
    connError: 'Codex app-server exited (1).\nthread panicked',
  });
  let r = await render(h(AccountExpiredBanner));
  const alert = r.host.querySelector('[role=alert]');
  assert.match(text(alert), /^Codex 0\.163\.0-alpha\.10\.2 from ChatGPT\.app keeps quitting, so MoPilot stopped restarting it\./);
  assert.equal(
    [...r.host.querySelectorAll('button')].some((b) => text(b) === 'Settings'),
    false,
    'Use another Codex takes its place',
  );
  await click(button(r.host, 'Use another Codex'));
  assert.deepEqual(calls.at(-1), ['navigate', { name: 'settings', section: 'codex', tab: 'advanced' }]);
  await click(button(r.host, 'Copy crash output'));
  await flush();
  assert.deepEqual(
    calls.find((c) => c[0] === 'clipboard.write'),
    ['clipboard.write', `Codex 0.163.0-alpha.10.2 from ChatGPT.app (${copy.path})\nCodex app-server exited (1).\nthread panicked`],
  );
  assert.deepEqual(calls.at(-1), ['toast', 'Crash output copied']);
  await r.unmount();
  // the user's own pick: kept, and said to be theirs
  useStore.setState({ codexQuit: { copy: { path: '/Users/me/bin/codex', version: null, via: null, from: null }, pinned: true } });
  r = await render(h(AccountExpiredBanner));
  assert.match(
    text(r.host.querySelector('[role=alert]')),
    /^Codex at ~\/bin\/codex keeps quitting, so MoPilot stopped restarting it\. It's the copy you picked\./,
  );
  await r.unmount();
});
