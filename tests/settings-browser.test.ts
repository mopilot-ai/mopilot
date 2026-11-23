// Settings → Voice, Quick Chat and Browser.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  setup,
  calls,
  ctl,
  responses,
  resetCtl,
  defaultState,
  useStore,
  render,
  click,
  text,
  button,
  row,
  pick,
  options,
  setValue,
  key,
  blur,
  flush,
  lastPrefs,
  toggle,
} from './support/settings-harness.ts';
import { window } from './support/dom.ts';

await setup();
const { createElement: h, act } = await import('react');
const { Settings } = await import('../src/components/pages/Settings.tsx');

const prefs = (p: any) => useStore.setState({ prefs: { ...useStore.getState().prefs, ...p } });
const section = (s: string) => render(h(Settings, { section: s }));
const setMedia = (value: any) => Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value });
// The Browser page's Sites table (settings/BrowserUse.tsx) reads Codex Browser Use and Claude in Chrome's links.
const browserUse = () => {
  responses['browserUse.state'] = { file: 'browser/config.toml', error: 'missing' };
  responses['availability.chromeLinks'] = [];
  responses['availability.onChromeLinksChanged'] = () => () => {};
};
beforeEach(() => {
  resetCtl();
  useStore.setState(defaultState(), true);
  setMedia(undefined);
  browserUse();
});

test('voice: microphones, engine and language selects write prefs', async () => {
  setMedia({
    enumerateDevices: async () => [
      { kind: 'audioinput', deviceId: 'default', label: 'Default' },
      { kind: 'audioinput', deviceId: 'm1', label: 'USB Mic' },
      { kind: 'videoinput', deviceId: 'v1', label: 'Cam' },
      { kind: 'audioinput', deviceId: 'm2', label: '' },
    ],
  });
  ctl.dictationEngine = 'local';
  const { host, unmount } = await section('voice');
  await flush();
  const mic = () => row(host, 'Microphone');
  await click(mic().querySelector('.select-btn')!);
  assert.deepEqual(options(mic()), ['System default', 'USB Mic']);
  await pick(mic(), 'USB Mic');
  assert.deepEqual(lastPrefs(), { micDeviceId: 'm1' });
  await pick(mic(), 'System default');
  assert.deepEqual(lastPrefs(), { micDeviceId: null });
  const engine = () => row(host, 'Dictation engine');
  assert.equal(text(engine().querySelector('.select-btn')), 'Automatic', 'nothing pinned: Automatic, naming what it uses');
  assert.match(text(engine().querySelector('.settings-row-desc')), /^Uses This Mac\./);
  calls.length = 0;
  await pick(engine(), 'ChatGPT account');
  assert.deepEqual(calls, [['setPrefs', { dictationEngine: 'chatgpt' }]]);
  await pick(row(host, 'Language'), 'Japanese');
  assert.deepEqual(lastPrefs(), { dictationLanguage: 'ja' });
  await unmount();
});

test('voice: choosing the on-device engine reports why it cannot work', async () => {
  setMedia({ enumerateDevices: () => Promise.reject(new Error('blocked')) });
  prefs({ dictationEngine: 'chatgpt', dictationLanguage: 'en' });
  const { host, unmount } = await section('voice');
  await flush();
  const replies: [any, string | null][] = [
    [null, "Couldn't start the on-device recognizer"],
    [{ failure: 'The helper stopped.' }, 'The helper stopped.'],
    [{ authorization: 'denied' }, 'Allow Speech Recognition for "MoPilot" in System Settings → Privacy & Security'],
    [{ authorization: 'authorized', available: false, onDevice: true, locale: 'en-US' }, "On-device recognition isn't available for en-US"],
    [{ authorization: 'authorized', available: true, onDevice: false, locale: 'fr-FR' }, "On-device recognition isn't available for fr-FR"],
    [{ authorization: 'authorized', available: true, onDevice: true, locale: 'en-US' }, null],
  ];
  for (const [reply, msg] of replies) {
    responses['dictation.localRequest'] = reply;
    calls.length = 0;
    await pick(row(host, 'Dictation engine'), 'This Mac');
    await flush();
    assert.deepEqual(calls.slice(1, 3), [['dictation.localRequest', 'en'], ...(msg ? [['toast', msg, 'error']] : [])]);
  }
  await unmount();
});

test('voice: an unknown saved voice shows the default, and choosing one saves it', async () => {
  prefs({ voice: 'alloy' });
  const { host, unmount } = await section('voice');
  assert.equal(text(row(host, 'Voice').querySelector('.select-btn')), 'Cove');
  await pick(row(host, 'Voice'), 'Maple');
  assert.deepEqual(lastPrefs(), { voice: 'maple' });
  await unmount();
});

test('voice hotkey records an accelerator, rejects one in use, and turns off', async () => {
  const { host, unmount } = await section('voice');
  const field = () => row(host, 'Voice input hotkey');
  assert.equal(text(field().querySelector('.settings-value')), 'Off');
  assert.equal(buttons(field(), 'Turn off').length, 0);
  await click(button(field(), 'Edit shortcut'));
  assert.equal(text(field().querySelector('.kbd-recording')), 'Press keys…');
  await click(button(field(), 'Edit shortcut'));
  assert.equal(field().querySelector('.kbd-recording'), null);
  await click(button(field(), 'Edit shortcut'));
  await key(window as any, { key: 'Escape', code: 'Escape' });
  assert.equal(field().querySelector('.kbd-recording'), null);
  await click(button(field(), 'Edit shortcut'));
  await key(window as any, { key: 'Meta', code: 'MetaLeft', metaKey: true });
  await key(window as any, { key: 'a', code: 'KeyA' });
  assert.ok(field().querySelector('.kbd-recording'));
  responses['voice.setHotkey'] = false;
  await key(window as any, { key: 'k', code: 'KeyK', metaKey: true, shiftKey: true });
  await flush();
  assert.deepEqual(calls.slice(-2), [
    ['voice.setHotkey', 'Shift+Command+K'],
    ['toast', 'That shortcut is already in use', 'error'],
  ]);
  responses['voice.setHotkey'] = true;
  const combos: [any, string][] = [
    [{ key: '5', code: 'Digit5', ctrlKey: true }, 'Control+5'],
    [{ key: ' ', code: 'Space', altKey: true }, 'Alt+Space'],
    [{ key: 'é', code: 'Quote', altKey: true }, 'Alt+É'],
    [{ key: 'F5', code: 'F5', metaKey: true }, 'Command+F5'],
  ];
  for (const [ev, acc] of combos) {
    await click(button(field(), 'Edit shortcut'));
    await key(window as any, ev);
    await flush();
    assert.deepEqual(lastPrefs(), { voiceHotkey: acc });
  }
  prefs({ voiceHotkey: 'Control+Alt+Shift+Command+Space' });
  await flush();
  assert.equal(text(field().querySelector('kbd')), '⌃⌥⇧⌘Space');
  calls.length = 0;
  await click(button(field(), 'Turn off'));
  await flush();
  assert.deepEqual(calls, [
    ['voice.setHotkey', null],
    ['setPrefs', { voiceHotkey: null }],
  ]);
  await unmount();
});
test('voice: a request that fails says why, and the setting or list stays as main has it', async () => {
  ctl.dictationEngine = new Error('no answer');
  responses['dictation.localRequest'] = () => Promise.reject(new Error('helper gone'));
  responses['voice.setHotkey'] = () => Promise.reject(new Error('shortcut service down'));
  responses['recordings.list'] = () => Promise.reject(new Error('EACCES'));
  prefs({ dictationEngine: null, voiceHotkey: 'Control+5' });
  const { host, unmount } = await section('voice');
  await flush();
  assert.equal(text(row(host, 'Dictation engine').querySelector('.select-btn')), 'Automatic', 'unanswered: the choice and why');
  assert.match(text(row(host, 'Dictation engine').querySelector('.settings-row-desc')), /no answer/);
  calls.length = 0;
  await pick(row(host, 'Dictation engine'), 'This Mac');
  await flush();
  assert.deepEqual(calls.at(-1), ['toast', "Couldn't start the on-device recognizer: helper gone", 'error']);
  calls.length = 0;
  await click(button(row(host, 'Voice input hotkey'), 'Turn off'));
  await flush();
  assert.deepEqual(calls, [
    ['voice.setHotkey', null],
    ['toast', "Couldn't change the voice chat hotkey: shortcut service down", 'error'],
  ]);
  assert.equal(useStore.getState().prefs.voiceHotkey, 'Control+5', 'still registered, so still shown');
  await click(row(host, 'Recent recordings'));
  await flush();
  assert.match(text(host), /Couldn't read the recordings: EACCES/);
  assert.doesNotMatch(text(host), /No recordings yet/);
  // a list that reads; then playing or deleting that fails says so
  responses['recordings.list'] = [{ id: 'r1', text: 'hello there', at: Date.UTC(2026, 0, 2) }];
  await click(row(host, 'Recent recordings'));
  await click(row(host, 'Recent recordings'));
  await flush();
  const rec = [...host.querySelectorAll('.settings-row')].find((r) => text(r.querySelector('.settings-row-desc')) === 'hello there')!;
  responses['recordings.read'] = () => Promise.reject(new Error('gone'));
  await click(button(rec as Element, 'Play'));
  await flush();
  assert.deepEqual(calls.at(-1), ['toast', "Couldn't play the recording: gone", 'error']);
  responses['recordings.clear'] = () => Promise.reject(new Error('busy'));
  await click(button(row(host, 'Delete all recordings'), 'Delete'));
  await flush();
  assert.deepEqual(calls.at(-1), ['toast', "Couldn't delete the recordings: busy", 'error']);
  assert.ok(rec.isConnected, 'the recordings stay listed');
  await unmount();
});

const buttons = (root: Element, label: string) =>
  [...root.querySelectorAll('button')].filter((b) => b.getAttribute('aria-label') === label);

for (const outcome of ['success', 'failure'] as const) {
  test(`recordings ignore a stale ${outcome} after closing and reopening`, async () => {
    let resolve!: (value: any) => void;
    let reject!: (error: Error) => void;
    const pending = new Promise((yes, no) => {
      resolve = yes;
      reject = no;
    });
    responses['recordings.list'] = () => pending;
    const { host, unmount } = await section('voice');
    await click(row(host, 'Recent recordings'));
    await click(row(host, 'Recent recordings'));
    responses['recordings.list'] = [{ id: 'new', text: 'current recording', at: 1 }];
    await click(row(host, 'Recent recordings'));
    await flush();
    await act(async () => {
      if (outcome === 'success') resolve([{ id: 'old', text: 'obsolete recording', at: 1 }]);
      else reject(new Error('obsolete failure'));
    });
    assert.match(text(host), /current recording/);
    assert.doesNotMatch(text(host), /obsolete recording|obsolete failure/);
    await unmount();
  });

  test(`recordings ignore a pending ${outcome} after successful deletion`, async () => {
    responses['recordings.list'] = [{ id: 'old', text: 'recording to delete', at: 1 }];
    const { host, unmount } = await section('voice');
    await click(row(host, 'Recent recordings'));
    await flush();
    await click(row(host, 'Recent recordings'));
    let resolve!: (value: any) => void;
    let reject!: (error: Error) => void;
    const pending = new Promise((yes, no) => {
      resolve = yes;
      reject = no;
    });
    responses['recordings.list'] = () => pending;
    await click(row(host, 'Recent recordings'));
    await click(button(row(host, 'Delete all recordings'), 'Delete'));
    await flush();
    await act(async () => {
      if (outcome === 'success') resolve([{ id: 'old', text: 'recording to delete', at: 1 }]);
      else reject(new Error('obsolete failure'));
    });
    assert.match(text(host), /No recordings yet/);
    assert.doesNotMatch(text(host), /recording to delete|obsolete failure/);
    await unmount();
  });
}

test('a delayed deletion reply cannot erase a newer reopened recording list', async () => {
  responses['recordings.list'] = [{ id: 'old', text: 'recording to delete', at: 1 }];
  const { host, unmount } = await section('voice');
  await click(row(host, 'Recent recordings'));
  let finish!: () => void;
  const pending = new Promise<void>((resolve) => {
    finish = resolve;
  });
  responses['recordings.clear'] = () => pending;
  await click(button(row(host, 'Delete all recordings'), 'Delete'));
  await click(row(host, 'Recent recordings'));
  responses['recordings.list'] = [{ id: 'new', text: 'recorded after deletion', at: 2 }];
  await click(row(host, 'Recent recordings'));
  await flush();
  await act(async () => finish());
  assert.match(text(host), /recorded after deletion/);
  await unmount();
});

test('recordings expand to play or delete them', async () => {
  responses['recordings.list'] = [{ id: 'r1', text: 'hello there', at: Date.UTC(2026, 0, 2) }];
  const { host, unmount } = await section('voice');
  assert.throws(() => row(host, 'Delete all recordings'));
  await click(row(host, 'Recent recordings'));
  await flush();
  assert.ok(row(host, 'Delete all recordings'));
  const rec = [...host.querySelectorAll('.settings-row')].find((r) => text(r.querySelector('.settings-row-desc')) === 'hello there')!;
  responses['recordings.read'] = 'blob:audio';
  await click(button(rec as Element, 'Play'));
  await flush();
  assert.deepEqual(calls.at(-1), ['play', 'blob:audio']);
  responses['recordings.read'] = null;
  await click(button(rec as Element, 'Play'));
  await flush();
  assert.deepEqual(calls.at(-1), ['recordings.read', 'r1']);
  await click(button(row(host, 'Delete all recordings'), 'Delete'));
  await flush();
  assert.match(text(host), /No recordings yet/);
  await click(row(host, 'Recent recordings'));
  assert.doesNotMatch(text(host), /No recordings yet/);
  await unmount();
});

test('quick chat shortcut registers before saving and the window opens', async () => {
  const { host, unmount } = await section('mini');
  assert.equal(text(row(host, 'Quick Chat shortcut').querySelector('.settings-row-desc')), '[⌥Space]');
  responses['win.miniShortcut'] = false;
  await toggle(host, 'Quick Chat shortcut');
  await flush();
  assert.deepEqual(calls.slice(-2), [
    ['win.miniShortcut', true],
    ['toast', '[⌥Space] is already in use', 'error'],
  ]);
  responses['win.miniShortcut'] = true;
  await toggle(host, 'Quick Chat shortcut');
  await flush();
  assert.deepEqual(lastPrefs(), { miniShortcut: true });
  responses['win.miniShortcut'] = false;
  await toggle(host, 'Quick Chat shortcut');
  await flush();
  assert.deepEqual(lastPrefs(), { miniShortcut: false });
  await click(button(host, 'Open Quick Chat'));
  assert.deepEqual(calls.at(-1), ['win.mini']);
  await unmount();
});

test('browser general, data and downloads settings', async () => {
  responses['browser.sites'] = [];
  const { host, unmount } = await section('browser');
  await flush();
  assert.ok(host.querySelector('[data-stub=ClaudeInChromeNote]'));
  assert.equal(text(host.querySelector('.sites-empty')), 'No saved sites yet.');
  assert.equal(text(row(host, "Couldn't read browser/config.toml").querySelector('.settings-row-desc')), 'missing');
  await pick(row(host, 'Open local sites in'), 'Default browser');
  assert.deepEqual(lastPrefs(), { localUrlDestination: 'default' });
  await toggle(host, 'Show full URL');
  assert.deepEqual(lastPrefs(), { browserFullUrl: true });
  // importing from another browser: a button beside Clear browsing data opens the dialog (src/components/dialogs/BrowserImportDialog.tsx); the imported data is listed below
  assert.ok(host.querySelector('[data-stub=BrowserImportData]'));
  assert.match(
    text(row(host, 'Browsing data').querySelector('.settings-row-desc')),
    /^Clear history, cookies and cache, or import from another browser\.$/,
  );
  const asked: unknown[] = [];
  const onImport = (e: any) => {
    asked.push(e.detail);
  };
  window.addEventListener('open-browser-import', onImport);
  await click(button(host, 'Import…'));
  window.removeEventListener('open-browser-import', onImport);
  assert.deepEqual(asked, [null]);
  ctl.confirm = false;
  await click(button(host, 'Clear browsing data'));
  assert.equal(
    calls.some((c) => c[0] === 'browser.clearData'),
    false,
  );
  ctl.confirm = true;
  await click(button(host, 'Clear browsing data'));
  await flush();
  assert.deepEqual(calls.slice(-2), [['browser.clearData'], ['toast', 'Browsing data cleared']]);
  // a clear that failed part way says so, not that it cleared
  responses['browser.clearData'] = () => Promise.reject(new Error('cache is busy'));
  await click(button(host, 'Clear browsing data'));
  await flush();
  delete responses['browser.clearData'];
  assert.deepEqual(calls.slice(-2), [['browser.clearData'], ['toast', "Couldn't clear browsing data: cache is busy", 'error']]);
  const loc = () => row(host, 'Location');
  assert.equal(text(loc().querySelector('.settings-row-desc')), 'System Downloads folder');
  responses['dialog.openFolder'] = null;
  calls.length = 0;
  await click(button(loc(), 'Change'));
  assert.deepEqual(calls, [['dialog.openFolder']]);
  responses['dialog.openFolder'] = '/Users/me/Downloads/agents/with/a/very/long/folder/name';
  await click(button(loc(), 'Change'));
  // the setting changes once main uses it
  assert.deepEqual(calls.slice(-2), [
    ['browser.setDownloads', '/Users/me/Downloads/agents/with/a/very/long/folder/name', false],
    ['setPrefs', { downloadsDir: '/Users/me/Downloads/agents/with/a/very/long/folder/name' }],
  ]);
  assert.equal(text(loc().querySelector('.settings-row-desc')).length, 38);
  await toggle(host, 'Ask where to save');
  assert.deepEqual(calls.slice(-2), [
    ['browser.setDownloads', '/Users/me/Downloads/agents/with/a/very/long/folder/name', true],
    ['setPrefs', { askWhereToSave: true }],
  ]);
  await unmount();
});

test('browser settings without the import switch have no import button', async () => {
  responses['browser.sites'] = [];
  ctl.flags['shared.browser.import'] = false;
  const { host, unmount } = await section('browser');
  await flush();
  assert.equal(
    [...host.querySelectorAll('button')].some((b) => text(b) === 'Import…'),
    false,
  );
  assert.doesNotMatch(text(row(host, 'Browsing data').querySelector('.settings-row-desc')), /another browser/);
  await unmount();
});

test('site permissions change level or remove a site', async () => {
  // the built-in browser's table has the site; Your Chrome's is empty
  responses['browser.sites'] = (browser: string) =>
    Promise.resolve(browser === 'chrome' ? [] : [{ origin: 'https://a.com', level: 'read' }]);
  responses['browser.setSite'] = (origin: string, level: any) => Promise.resolve(level ? [{ origin, level }] : []);
  const { host, unmount } = await section('browser');
  await flush();
  const level = () => host.querySelector('[aria-label="Built-in browser for https://a.com"]') as HTMLSelectElement;
  assert.equal(level().value, 'read');
  assert.equal((host.querySelector('[aria-label="Your Chrome for https://a.com"]') as HTMLSelectElement).value, '');
  await setValue(level(), 'write', 'change');
  await flush();
  assert.deepEqual(calls.at(-1), ['browser.setSite', 'https://a.com', 'write', 'iab']);
  assert.equal(level().value, 'write');
  await click(button(host, 'Remove https://a.com'));
  await flush();
  assert.deepEqual(calls.at(-1), ['browser.setSite', 'https://a.com', null, 'iab']);
  assert.equal(level(), null);
  assert.equal(text(host.querySelector('.sites-empty')), 'No saved sites yet.');
  await unmount();
});

test('Preferred browser switches to your Chrome and configures it; the row says which browser agents use', async () => {
  responses['browser.chromeState'] = () => new Promise(() => undefined);
  // a channel switch restarts nothing: chats still waiting on an earlier profile change are not announced again
  responses['browser.configure'] = { active: 'builtin', hasToken: false, extensionUrl: 'https://ext', waitingChats: 1 };
  const { host, unmount } = await section('browser');
  const pref = () => row(host, 'Preferred browser');
  const desc = () => text(pref().querySelector('.settings-row-desc'));
  assert.equal(desc(), 'Agents use the built-in browser unless you ask otherwise.');
  calls.length = 0;
  await pick(pref(), 'Built-in browser');
  assert.deepEqual(calls, [], 'the current choice changes nothing');
  await pick(pref(), 'Chrome');
  await flush();
  assert.deepEqual(calls, [
    ['browser.configure', { channel: 'chrome', profileDir: '' }],
    ['setPrefs', { browserChannel: 'chrome' }],
  ]);
  assert.equal(desc(), "Chrome isn't available. Test the connection below.");
  await pick(pref(), 'Built-in browser');
  await flush();
  assert.deepEqual(lastPrefs(), { browserChannel: 'builtin' });
  assert.equal(host.querySelector('[aria-label="Connection token"]'), null);
  responses['browser.configure'] = { active: 'chrome', hasToken: false, extensionUrl: 'https://ext' };
  await pick(pref(), 'Chrome');
  await flush();
  assert.deepEqual(lastPrefs(), { browserChannel: 'chrome' });
  assert.equal(desc(), 'Agents use your Chrome unless you ask otherwise.');
  await unmount();
});

test('Preferred browser stays on the committed value until main finishes configuring it', async () => {
  let resolve!: (s: any) => void;
  responses['browser.configure'] = () =>
    new Promise((r) => {
      resolve = r;
    });
  const { host, unmount } = await section('browser');
  const label = () => text(row(host, 'Preferred browser').querySelector('.select-label'));
  await pick(row(host, 'Preferred browser'), 'Chrome');
  assert.equal(label(), 'Built-in browser');
  assert.equal(useStore.getState().prefs.browserChannel, 'builtin');
  await act(async () => resolve({ active: 'chrome', hasToken: false, extensionUrl: 'https://ext' }));
  await flush();
  assert.equal(label(), 'Chrome');
  assert.equal(useStore.getState().prefs.browserChannel, 'chrome');
  await unmount();
});

test('your Chrome: extension link, token save and remove, profile and connection test', async () => {
  prefs({ browserChannel: 'chrome', chromeProfileDir: 'Default' });
  let state!: (v: any) => void;
  responses['browser.chromeState'] = () => new Promise((r) => (state = r));
  const { host, unmount } = await section('browser');
  calls.length = 0;
  const extension = () => row(host, 'Playwright Extension');
  assert.equal(extension().querySelector('.settings-row-title')!.textContent, 'Playwright Extension');
  await click(button(extension(), 'Get the extension'));
  assert.deepEqual(calls, []);
  assert.doesNotMatch(text(host), /Your Chrome isn't available/);
  state({ active: 'chrome', hasToken: false, extensionUrl: 'https://ext' });
  await flush();
  assert.doesNotMatch(text(host), /Your Chrome isn't available/);
  await click(button(extension(), 'Get the extension'));
  assert.deepEqual(calls.at(-1), ['shell.openExternal', 'https://ext']);
  const token = () => row(host, 'Connection token');
  assert.match(text(token().querySelector('.settings-row-desc')), /^Optional/);
  assert.ok(button(token(), 'Save').disabled);
  await setValue(token().querySelector('input')!, 'tok');
  responses['browser.setChromeToken'] = false;
  responses['browser.chromeState'] = { active: 'chrome', hasToken: true, extensionUrl: 'https://ext' };
  await click(button(token(), 'Save'));
  await flush();
  assert.deepEqual(calls.filter((c) => c[0] !== 'browser.chromeState').slice(-2), [
    ['browser.setChromeToken', 'tok'],
    ['toast', "Couldn't save the token in the keychain", 'error'],
  ]);
  assert.match(text(token().querySelector('.settings-row-desc')), /Saved in your keychain/);
  // a keychain that refuses: the toast says why, and the token stays in the field
  await setValue(token().querySelector('input')!, 'tok2');
  responses['browser.setChromeToken'] = () => Promise.reject(new Error('access denied'));
  calls.length = 0;
  await click(button(token(), 'Save'));
  await flush();
  assert.deepEqual(calls, [
    ['browser.setChromeToken', 'tok2'],
    ['toast', "Couldn't save the token in the keychain: access denied", 'error'],
  ]);
  assert.equal(token().querySelector('input')!.value, 'tok2');
  await setValue(token().querySelector('input')!, '');
  const remove = button(token(), 'Remove');
  assert.equal(remove.disabled, false);
  responses['browser.setChromeToken'] = true;
  calls.length = 0;
  await click(remove);
  await flush();
  assert.deepEqual(calls, [['browser.setChromeToken', ''], ['browser.chromeState']]);
  const profile = () => row(host, 'Chrome profile').querySelector('input')!;
  await blur(profile());
  assert.equal(
    calls.some((c) => c[0] === 'browser.configure'),
    false,
  );
  responses['browser.configure'] = { active: 'chrome', hasToken: true, extensionUrl: 'https://ext' };
  await setValue(profile(), ' Profile 1 ');
  await blur(profile());
  await flush();
  assert.deepEqual(calls.slice(-2), [
    ['browser.configure', { channel: 'chrome', profileDir: 'Profile 1' }],
    ['setPrefs', { chromeProfileDir: 'Profile 1' }],
  ]);
  let tested!: (v: any) => void;
  responses['browser.testChrome'] = () => new Promise((r) => (tested = r));
  const conn = () => row(host, 'Connection');
  assert.equal(text(conn().querySelector('.settings-row-desc')), 'Opens a tab group in Chrome and closes it again.');
  await click(button(conn(), 'Test connection'));
  assert.equal(text(conn().querySelector('.settings-row-desc')), 'Connecting to Chrome…');
  assert.ok(button(conn(), 'Test connection').disabled);
  tested({ ok: true, message: 'Connected' });
  await flush();
  assert.equal(text(conn().querySelector('.settings-row-desc')), 'Connected');
  // without a saved token the test waits for an approval in Chrome, so say where
  responses['browser.configure'] = { active: 'chrome', hasToken: false, extensionUrl: 'https://ext' };
  await setValue(profile(), 'Profile 2');
  await blur(profile());
  await flush();
  responses['browser.testChrome'] = () => new Promise((r) => (tested = r));
  await click(button(conn(), 'Test connection'));
  assert.match(text(conn().querySelector('.settings-row-desc')), /^Connecting to Chrome… Approve it in Chrome: click "Allow & select"/);
  tested({ ok: false, message: 'Timed out' });
  await flush();
  // a chat working in Chrome keeps its connection until its turn ends (CM-Y03a): Settings says so, once or for several
  responses['browser.configure'] = { active: 'chrome', hasToken: false, extensionUrl: 'https://ext', waitingChats: 1 };
  await setValue(profile(), 'Profile 3');
  await blur(profile());
  await flush();
  // the setting changes once main has switched to the new profile
  assert.deepEqual(calls.slice(-2), [
    ['toast', 'A chat in Chrome switches when its turn ends.', 'info'],
    ['setPrefs', { chromeProfileDir: 'Profile 3' }],
  ]);
  responses['browser.chromeState'] = { active: 'chrome', hasToken: true, extensionUrl: 'https://ext', waitingChats: 2 };
  await setValue(token().querySelector('input')!, 'tok2');
  await click(button(token(), 'Save'));
  await flush();
  assert.deepEqual(calls.at(-1), ['toast', '2 chats in Chrome switch when their turn ends.', 'info']);
  await unmount();
});

test("downloads and the agents' browser say when main couldn't apply the change; an unreadable Chrome state is left out", async () => {
  responses['browser.setDownloads'] = () => Promise.reject(new Error('read-only'));
  responses['browser.configure'] = () => Promise.reject(new Error('no Chrome'));
  responses['browser.chromeState'] = () => Promise.reject(new Error('unreadable'));
  responses['dialog.openFolder'] = '/tmp/dl';
  const { host, unmount } = await section('browser');
  await flush();
  assert.doesNotMatch(text(host), /Your Chrome isn't available/);
  await click(button(row(host, 'Location'), 'Change'));
  await flush();
  assert.deepEqual(calls.at(-1), ['toast', "Couldn't change where downloads go: read-only", 'error']);
  await toggle(host, 'Ask where to save');
  await flush();
  assert.deepEqual(calls.at(-1), ['toast', "Couldn't change where downloads go: read-only", 'error']);
  await pick(row(host, 'Preferred browser'), 'Chrome');
  await flush();
  assert.deepEqual(calls.at(-1), ['toast', "Couldn't switch the agents' browser: no Chrome", 'error']);
  // main didn't switch, so neither does the setting; nor do the downloads settings it refused
  assert.equal(useStore.getState().prefs.browserChannel, 'builtin');
  assert.equal(useStore.getState().prefs.downloadsDir, null);
  assert.equal(useStore.getState().prefs.askWhereToSave, false);
  await unmount();
});
