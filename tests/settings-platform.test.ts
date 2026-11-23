// Settings on Windows: Ctrl+Enter, no on-device dictation, and ssh.exe for SSH hosts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup, calls, useStore, render, click, button, row, options, flush } from './support/settings-harness.ts';
import { defined } from './support/defined.ts';

await setup({ isMac: false, isWin: true });
const { createElement: h } = await import('react');
const { Settings, SshConnections } = await import('../src/components/pages/Settings.tsx');

test('send-with and dictation choices follow the platform', async () => {
  let r = await render(h(Settings, { section: 'general' }));
  await click(row(r.host, 'Send with').querySelector('.select-btn')!);
  assert.deepEqual(options(row(r.host, 'Send with')), ['Enter', 'Ctrl+Enter']);
  await r.unmount();
  r = await render(h(Settings, { section: 'voice' }));
  await flush();
  await click(row(r.host, 'Dictation engine').querySelector('.select-btn')!);
  assert.deepEqual(options(row(r.host, 'Dictation engine')), ['Automatic', 'ChatGPT account', 'MoPilot credits']);
  await r.unmount();
});

test('ssh connects with ssh.exe on Windows', async () => {
  useStore.setState({ prefs: { ...useStore.getState().prefs, sshHosts: ['me@box'] } });
  const { host, unmount } = await render(h(SshConnections));
  await click(button(row(host, 'me@box'), 'Connect'));
  assert.deepEqual(defined(calls.find((c) => c[0] === 'openPaneTab'))[2].command, ['ssh.exe', 'me@box']);
  await unmount();
});
