// The welcome page's optional Chrome row (src/components/pages/WelcomeChrome.tsx): nothing without the extension, else Connected, or its next step and why, as Settings has them (#2034).
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import './support/dom.ts';
import { UNKNOWN_CAPABILITY_REASON } from '../shared/capabilityReasons.mjs';
import { installNativeStub } from './support/ports/native.ts';
import { stubStore } from './support/stubs.ts';

const calls: unknown[][] = [];
let status: any = null;
let fail = false;
const answer = (name: string) => async () => {
  calls.push([name]);
  if (fail) throw new Error('no Chrome');
  return 'opened';
};
mock.module('../src/session/nativeAvailability.ts', { namedExports: { useNativeAvailability: () => status } });
installNativeStub({
  availability: { chromeInstall: answer('chromeInstall'), chromeAllow: answer('chromeAllow'), chromePair: answer('chromePair') },
});
stubStore({
  toast: (text: string, kind: string) => calls.push(['told', text, kind]),
  toastFailure: (what: string) => (e: unknown) => calls.push(['toast', what, String(e)]),
});
// the row's Connected mark is the agent rows' (WelcomeAgents.tsx, tested with the welcome page)
mock.module('../src/components/pages/WelcomeAgents.tsx', { namedExports: { Connected: () => 'Connected' } });
const { createElement, act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { WelcomeChrome } = await import('../src/components/pages/WelcomeChrome.tsx');

async function render() {
  const host = document.createElement('div');
  const root = createRoot(host);
  await act(() => root.render(createElement(WelcomeChrome)));
  return { host, root };
}

test('nothing where the build has no extension, or before the status is read', async () => {
  for (const s of [null, { extension: null }]) {
    status = s;
    const { host, root } = await render();
    assert.equal(host.innerHTML, '');
    await act(() => root.unmount());
  }
});

const ADD = { kind: 'chromeInstall', label: 'Add to Chrome' };
const ALLOW = { kind: 'chromeAllow', label: 'Allow' };
const PAIR = { kind: 'chromePair', label: 'Connect' };

test('Connected, or each state with its next step and why, as electron/capabilities/nativeAvailability/extensionStatus.cjs has them', async () => {
  // [extension, what the row's head shows, the step its button runs, its hint]
  const cases: [any, string, string | null, string | null][] = [
    // what it gives, with the extension named as Settings → Browser names it (#2034)
    [
      { state: 'mopilot', label: 'Connected', actions: [] },
      'Connected',
      null,
      'Agents can work in your signed-in Chrome through the MoPilot extension.',
    ],
    [
      { state: 'permissions', label: 'Not installed', reasonCode: 'chrome.install', actions: [ADD] },
      'Add to Chrome',
      'chromeInstall',
      'Add the MoPilot extension to Chrome.',
    ],
    [
      { state: 'permissions', label: 'Waiting for your OK', reasonCode: 'chrome.allow', actions: [ALLOW] },
      'Allow',
      'chromeAllow',
      'Allow MoPilot to use this Chrome.',
    ],
    // #2034: these said only "Not connected"
    [
      { state: 'permissions', label: 'Not connected', reasonCode: 'chrome.pair', actions: [PAIR] },
      'Connect',
      'chromePair',
      'Press Connect; if MoPilot then asks, click Allow in MoPilot.',
    ],
    [
      { state: 'unknown', label: 'Not connected', reasonCode: 'chrome.connect', actions: [PAIR] },
      'Connect',
      'chromePair',
      'Open Chrome with the extension on.',
    ],
    [
      { state: 'permissions', label: 'Off in Chrome', reasonCode: 'chrome.extensionOff', actions: [] },
      'Off in Chrome',
      null,
      'Turn it on in Chrome’s Extensions menu.',
    ],
    [
      { state: 'unavailable', label: 'Unavailable', reasonCode: 'chrome.restart', actions: [] },
      'Unavailable',
      null,
      'Restart MoPilot to enable Chrome control.',
    ],
    // a step that isn't the extension's (none is offered today) is not a button here
    [
      { state: 'unavailable', label: 'Unavailable', reasonCode: 'chrome.tools', actions: [{ kind: 'retry', label: 'Try again' }] },
      'Unavailable',
      null,
      'Your Chrome couldn’t start. Test its connection in Browser settings.',
    ],
  ];
  for (const [extension, shown, call, hint] of cases) {
    status = { extension };
    calls.length = 0;
    fail = false;
    const { host, root } = await render();
    const head = host.querySelector('.welcome-row-head')!;
    assert.equal(head.textContent, `Use your Chrome${shown}`);
    assert.equal(host.querySelector('.welcome-row-hint')?.textContent ?? null, hint);
    // said to be optional, in words, not only to screen readers
    assert.equal(host.querySelector('#welcome-optional')!.textContent, 'Optional');
    const button = host.querySelector('button');
    if (call) {
      await act(async () => button!.click());
      fail = true;
      await act(async () => button!.click());
      assert.deepEqual(
        calls.map((c) => c[0]),
        call === 'chromePair' ? [call, 'told', call, 'toast'] : [call, call, 'toast'],
      );
    } else assert.equal(button, null);
    await act(() => root.unmount());
  }
});

// Guard (#2034): every state of MoPilot's own extension, as main makes it, reaches the welcome page with its reason
// and the same next step Settings offers, so a new state can't land here as a bare label.
const require = createRequire(import.meta.url);
const { chromeRelayHealth } = require('../electron/capabilities/capabilityHealth.cjs');
const { extensionStatus } = require('../electron/capabilities/nativeAvailability/extensionStatus.cjs');

test('every state main makes for the extension shows why, and every step it offers', async () => {
  const base = { enabled: true, running: true, kind: 'extension', installUrl: 'https://store/x' };
  const states = [
    { enabled: false },
    { running: false },
    { asking: true },
    { installed: 'missing' },
    // a build with no Web Store page: the reason alone, as in Settings
    { installed: 'missing', installUrl: null },
    { installed: 'off' },
    { installed: 'on', paired: false },
    { installed: 'on', paired: true },
    { connected: true },
  ].map((o) => ({ ...extensionStatus({ ...chromeRelayHealth({ ...base, ...o }), channel: 'extension' }), why: o }));
  const codes = new Set<string>();
  for (const extension of states) {
    status = { extension };
    const { host, root } = await render();
    const hint = host.querySelector('.welcome-row-hint')?.textContent ?? null;
    if (extension.state === 'mopilot') assert.match(hint!, /signed-in Chrome/);
    else {
      codes.add(extension.reasonCode);
      assert.ok(hint && hint !== UNKNOWN_CAPABILITY_REASON, `${extension.reasonCode}: a reason the user can act on`);
      const buttons = [...host.querySelectorAll('button')].map((b) => b.textContent);
      assert.deepEqual(
        buttons,
        extension.actions.map((a: any) => a.label),
        `${extension.reasonCode}: Settings' steps`,
      );
    }
    await act(() => root.unmount());
  }
  assert.deepEqual([...codes].sort(), [
    'chrome.allow',
    'chrome.connect',
    'chrome.extensionOff',
    'chrome.install',
    'chrome.pair',
    'chrome.relayOff',
    'chrome.restart',
  ]);
});
