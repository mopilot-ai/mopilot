// Settings → Computer History (#1363, src/components/pages/settings/ComputerHistory.tsx, ComputerHistoryExplainer.tsx, src/store/computerHistory.ts): off by default, the explainer before the first turn-on, status with Pause / Resume and the permission fix, the app and site lists (excluded apps can't be picked, refusals are said) and what is never recorded. The components are real; main is a fixture (tests/support/computer-history-ui.ts).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { window } from './support/dom.ts';
import { f, act, on, reset, mount, flush, lastOf, NEVER_SITES, CAPTURED, NEVER, STATUS_LABEL } from './support/computer-history-ui.ts';

test('off by default: only the switch, what is never recorded and the memories show; the lists stay hidden', async () => {
  reset();
  const v = await mount();
  assert.equal(v.q('.toggle').checked, false);
  assert.deepEqual(v.rows().slice(0, 1), ['Record activity']);
  assert.ok(!v.rows().includes('Add an app') && !v.rows().includes('Status'));
  assert.equal(v.row('Sites').getAttribute('data-desc'), NEVER_SITES);
  assert.match(v.row('Apps').getAttribute('data-desc'), /password manager, MoPilot/);
  assert.ok(v.rows().includes('Passwords and secure fields'));
  assert.ok(!f.calls.some(([c]: string[]) => c === 'candidates'), 'apps are listed only once it is on');
  await v.close();
});

test('the first turn-on goes through the explainer; Not now leaves it off, Turn on records and remembers', async () => {
  reset();
  const v = await mount();
  await v.click(v.q('.toggle'));
  const dialog = v.q('.ch-explainer');
  assert.ok(dialog, 'the explainer is shown');
  assert.deepEqual(
    [...dialog.querySelectorAll('[data-list="captured"] li')].map((li: any) => li.textContent),
    CAPTURED,
  );
  assert.deepEqual(
    [...dialog.querySelectorAll('[data-list="never"] li')].map((li: any) => li.textContent),
    NEVER,
  );
  assert.match(dialog.textContent, /deleted after 30 days/);
  assert.ok(!f.calls.some(([c]: string[]) => c === 'setEnabled'), 'nothing is turned on by opening it');
  await v.click(v.button('Not now', dialog));
  assert.equal(v.q('.ch-explainer'), null);
  assert.equal(v.q('.toggle').checked, false);
  await v.click(v.q('.toggle'));
  await v.click(v.button('Turn on', v.q('.ch-explainer')));
  assert.deepEqual(
    f.calls.filter(([c]: string[]) => c === 'explainerSeen' || c === 'setEnabled'),
    [['explainerSeen'], ['setEnabled', true]],
  );
  assert.equal(v.q('.toggle').checked, true);
  assert.equal(v.q('.ch-explainer'), null);
  assert.ok(v.rows().includes('Status') && v.rows().includes('Add an app'));
  // once seen, the switch goes straight through, both ways
  await v.click(v.q('.toggle'));
  assert.equal(v.q('.toggle').checked, false);
  await v.click(v.q('.toggle'));
  assert.equal(v.q('.ch-explainer'), null);
  assert.equal(v.q('.toggle').checked, true);
  await v.close();
});

test('status: Pause and Resume, and a missing permission says what to do with a way to fix it', async () => {
  reset(on());
  const v = await mount();
  assert.equal(v.q('.status-pill[data-status]').textContent, STATUS_LABEL.recording);
  assert.match(v.row('Status').getAttribute('data-desc'), /Recording the apps and sites below/);
  await v.click(v.button('Pause'));
  assert.equal(v.q('.status-pill[data-status]').textContent, 'Paused');
  assert.equal(v.row('Status').getAttribute('data-desc'), 'Nothing is recorded until you resume.');
  await v.click(v.button('Resume'));
  assert.equal(v.q('.status-pill[data-status]').textContent, 'Recording');
  await act(async () =>
    f.broadcast({ ...f.state, status: 'needs-permission', error: 'Computer History needs Accessibility for MoPilot Computer Use.' }),
  );
  await flush();
  assert.equal(v.q('.cu-guide'), null, 'the problem is said once, on the status row');
  assert.equal(v.row('Status').getAttribute('data-desc'), 'Computer History needs Accessibility for MoPilot Computer Use.');
  await v.click(v.button('Open System Settings'));
  assert.deepEqual(lastOf(), ['openSettings', 'accessibility']);
  f.opened = false;
  await v.click(v.button('Open System Settings'));
  assert.match(f.toasts.at(-1)[0], /Couldn't open System Settings/);
  f.native.computer.openSettings = async () => {
    throw new Error('helper gone');
  };
  await v.click(v.button('Open System Settings'));
  assert.match(f.toasts.at(-1)[0], /helper gone/);
  await v.close();
  f.native.computer.openSettings = async (k: string) => (f.calls.push(['openSettings', k]), f.opened);
});

test('apps: the running apps are offered, excluded ones disabled with the reason; refusals keep the pick; adding and removing reach main', async () => {
  reset(on());
  const v = await mount();
  const select = v.q('select[aria-label="App to add"]');
  const opts = [...select.querySelectorAll('option')].map((o: any) => [o.value, o.textContent, o.disabled]);
  assert.deepEqual(opts, [
    ['', 'Choose an app…', false],
    ['com.apple.TextEdit', 'TextEdit', false],
    ['com.1password.1password', '1Password — never recorded (password manager)', true],
  ]);
  assert.equal(v.button('Add').disabled, true);
  await v.pick(select, 'com.apple.TextEdit');
  f.refuseNext = 'At most 100 apps';
  await v.click(v.button('Add'));
  assert.deepEqual(f.toasts.at(-1), ["Couldn't add TextEdit: At most 100 apps", 'error']);
  assert.equal(v.q('select[aria-label="App to add"]').value, 'com.apple.TextEdit', 'a refused pick stays');
  f.refuseNext = null;
  await v.click(v.button('Add'));
  assert.deepEqual(lastOf(), ['allowApp', 'com.apple.TextEdit']);
  assert.ok(v.rows().includes('TextEdit'));
  assert.equal(v.q('select[aria-label="App to add"]').value, '');
  assert.ok(
    ![...v.q('select[aria-label="App to add"]').querySelectorAll('option')].some((o: any) => o.value === 'mopilot:built-in-browser'),
    'the built-in browser is not offered until it is a capture source',
  );
  await v.click(v.host.querySelector('button[aria-label="Remove Notes"]'));
  assert.deepEqual(lastOf(), ['removeApp', 'com.apple.Notes']);
  assert.ok(!v.rows().includes('Notes'));
  await v.close();
});

test('apps: a failed list of running apps says so and offers nothing to pick', async () => {
  reset(on());
  f.candidatesAnswer = async () => ({ ok: false, error: 'The computer-use helper is not available' });
  const v = await mount();
  assert.match(v.row('Add an app').getAttribute('data-desc'), /helper is not available/);
  assert.equal(v.q('select[aria-label="App to add"]').querySelectorAll('option').length, 1);
  await v.close();
  reset(on());
  f.candidatesAnswer = async () => {
    throw new Error('IPC gone');
  };
  const w = await mount();
  assert.match(w.row('Add an app').getAttribute('data-desc'), /IPC gone/);
  await w.close();
});

test('sites: Enter adds one, a refusal or failure keeps what was typed, Remove takes one off', async () => {
  reset(on());
  const v = await mount();
  const input = v.q('input[aria-label="Site to add"]');
  const type = async (text: string) => {
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!;
      setter.call(input, text);
      input.dispatchEvent(new window.Event('input', { bubbles: true }));
    });
    await flush();
  };
  const enter = async () => {
    await act(async () => input.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true })));
    await flush();
  };
  await enter();
  assert.ok(!f.calls.some(([c]: string[]) => c === 'allowSite'), 'nothing typed, nothing sent');
  f.refuseNext = 'Computer History never records this site (Banking site)';
  await type('chase.com');
  await enter();
  assert.match(f.toasts.at(-1)[0], /Banking site/);
  assert.equal(input.value, 'chase.com');
  f.refuseNext = null;
  f.throwNext = 'disk full';
  await enter();
  assert.match(f.toasts.at(-1)[0], /disk full/);
  f.throwNext = null;
  await type(' docs.example.org ');
  await enter();
  assert.deepEqual(lastOf(), ['allowSite', ' docs.example.org ']);
  assert.equal(input.value, '');
  assert.ok(v.rows().includes('docs.example.org'));
  await v.click(v.host.querySelector('button[aria-label="Remove example.com"]'));
  assert.deepEqual(lastOf(), ['removeSite', 'example.com']);
  await v.close();
});

test('apps: while the helper is unavailable the picker waits for it, and lists the apps once it is back', async () => {
  reset(on({ status: 'unavailable', error: "Computer History can't reach MoPilot Computer Use right now." }));
  const v = await mount();
  assert.match(v.row('Add an app').getAttribute('data-desc'), /Waiting for MoPilot Computer Use/);
  assert.ok(!f.calls.some(([c]: string[]) => c === 'candidates'));
  await act(async () => f.broadcast(on({ status: 'recording' })));
  await flush();
  assert.ok(f.calls.some(([c]: string[]) => c === 'candidates'));
  assert.equal(v.row('Add an app').getAttribute('data-desc'), 'Open the app first to see it here.');
  assert.equal(
    v.q('select[aria-label="App to add"]').querySelectorAll('option').length,
    3,
    'choose, TextEdit and 1Password (never recorded)',
  );
  await v.close();
});

test('the exclusions from a first read stay even when a broadcast overtook it', async () => {
  reset(on());
  let release: (v: unknown) => void = () => undefined;
  f.stateAnswer = () => new Promise((r) => (release = r));
  const v = await mount();
  await act(async () => f.broadcast(on()));
  await act(async () =>
    release({
      ok: true,
      state: on({ status: 'paused' }),
      exclusions: { apps: [{ pattern: 'com.1password.*', reason: 'password manager' }], healthSites: [] },
    }),
  );
  await flush();
  assert.equal(v.row('Apps').getAttribute('data-desc'), 'password manager');
  assert.equal(v.q('.status-pill[data-status]').textContent, 'Recording', 'the overtaken state is still ignored');
  await v.close();
});

test('apps: a running-apps list that lands after the status moved on is dropped for the newer read', async () => {
  reset(on());
  const answers: ((v: unknown) => void)[] = [];
  f.candidatesAnswer = () => new Promise((r) => answers.push(r));
  const v = await mount();
  await act(async () => f.broadcast(on({ status: 'paused' })));
  await flush();
  await act(async () => answers[1]({ ok: true, apps: [{ bundleId: 'com.apple.Mail', name: 'Mail', excluded: null }] }));
  await act(async () => answers[0]({ ok: true, apps: [{ bundleId: 'com.apple.TextEdit', name: 'TextEdit', excluded: null }] }));
  await flush();
  const names = [...v.q('select[aria-label="App to add"]').querySelectorAll('option')].map((o: any) => o.textContent);
  assert.ok(names.includes('Mail') && !names.includes('TextEdit'));
  await v.close();
});
