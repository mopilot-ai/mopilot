// The control matrix, group W (docs/control-plane/matrix.md): a Codex chat reaches the user's Chrome through the
// Codex Browser plugin even when the Codex desktop app's own built-in browser (Owl) runs a copy of the ChatGPT
// extension. Both copies report type "extension" and family "chrome", and the plugin's family lookup takes the first
// in an unsorted socket listing, so MoPilot tells the model to select Chrome by id (codexChromePick.cjs), names
// the instance ids it read from the profiles, and reads the Owl refusal as its own state with a next step.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { skyProblemOfItem } from '../shared/skyComputerUse.mjs';

export const GUARDS = ['electron/capabilities/', 'shared/'];

const require = createRequire(import.meta.url);
const { pickChromeBackend, instanceIdIn, readInstanceId, chatgptExtensionInstances, chromeSelectionNote, CHATGPT_EXTENSION_ID } =
  require('../electron/capabilities/browser/codexChromePick.cjs');
const { inAppBrowserNote, scopeNote, CodexToolInjection } = require('../electron/capabilities/channels/codexConfig.cjs');
const { ToolSessions } = require('../electron/capabilities/contract/session.cjs');

const CHROME_ID = '61d140d8-b711-4bfb-bb41-11756f2e0db2';
const OWL_ID = 'e6381772-a5fc-4388-8990-94a3060bcdee';
/** agent.browsers.list() entries as the plugin maps them (V0): Google Chrome's has a profileName, the Owl copy none. */
const chrome = {
  id: 'ab697c36',
  type: 'extension',
  family: 'chrome',
  name: 'Chrome',
  profileName: 'Person 1',
  metadata: { extensionInstanceId: CHROME_ID },
};
const owl = { id: '96667208', type: 'extension', family: 'chrome', name: 'Chrome', metadata: { extensionInstanceId: OWL_ID } };
const iab = { id: 'iab', type: 'iab', name: 'Built-in browser' };
const NONE = { chrome: [], codexApp: [] };

/** The plugin's agent.browsers.get(name) for a family name (browser-service.mjs KC/OF): the first match in list order. */
const vendorGetByFamily = (list: any[], family: string) => list.find((b) => b.type === 'extension' && (b.family ?? 'chrome') === family);

/** A fake agent whose browsers answer like the plugin's, recording what the program opened. */
function fakeAgent(list: any[]) {
  return {
    browsers: {
      list: async () => list,
      get: async (name: string) => (name === 'chrome' ? vendorGetByFamily(list, name) : list.find((b) => b.id === name)),
    },
  };
}

/** The selection program a note tells the model to run, as a function of `agent` returning the browser it got. */
function programOf(note: string) {
  const m = /binding\): (const chrome = await \(async \(\) => \{[\s\S]*?\}\)\(\);)/.exec(note);
  assert.ok(m, 'the note carries the selection program');
  const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;
  return new AsyncFunction('agent', `${m[1]}\nreturn chrome;`) as (agent: unknown) => Promise<any>;
}

const FAMILY_GET = /get\(\s*["'`]chrome["'`]\s*\)/;

test('CM-W01: the real Chrome is picked from two chrome-family extension backends in either order, where the family lookup is a coin flip', () => {
  for (const list of [
    [owl, chrome, iab],
    [chrome, owl, iab],
  ]) {
    assert.equal(pickChromeBackend(list, NONE), chrome, 'the one with a profileName');
    assert.equal(pickChromeBackend(list, { chrome: [CHROME_ID], codexApp: [] }), chrome, 'a known Chrome instance id');
  }
  // the vendor rule this works around: get("chrome") is the first chrome-family entry in socket order
  assert.equal(vendorGetByFamily([owl, chrome], 'chrome'), owl);
  assert.equal(vendorGetByFamily([chrome, owl], 'chrome'), chrome);
  // without profile names (the plugin could not read Chrome's profiles), known ids decide in both orders
  const bare = { ...chrome, profileName: undefined };
  for (const list of [
    [owl, bare],
    [bare, owl],
  ]) {
    assert.equal(pickChromeBackend(list, { chrome: [CHROME_ID], codexApp: [] }), bare);
    assert.equal(pickChromeBackend(list, { chrome: [], codexApp: [OWL_ID] }), bare, 'the known Codex-app copy is left out');
    assert.equal(pickChromeBackend(list, NONE), null, 'two unnamed candidates: no guess');
  }
  // one candidate left is the one; a known Codex-app copy alone, another family or only iab is none
  assert.equal(pickChromeBackend([bare, iab], NONE), bare);
  assert.equal(pickChromeBackend([{ ...bare, family: undefined }], NONE)?.id, chrome.id, 'no family reads as chrome');
  assert.equal(pickChromeBackend([owl], { chrome: [], codexApp: [OWL_ID] }), null);
  assert.equal(pickChromeBackend([{ ...chrome, family: 'edge' }, iab], NONE), null);
  assert.equal(pickChromeBackend([], NONE), null);
});

test('CM-W02: the Codex note never selects Chrome by family name, and its program opens the real Chrome by id in either order', async () => {
  const notes = [
    chromeSelectionNote(),
    chromeSelectionNote(null),
    chromeSelectionNote({ chrome: [CHROME_ID], codexApp: [OWL_ID] }),
    inAppBrowserNote('sage', true, true).value,
    inAppBrowserNote('sage', true, false).value,
    inAppBrowserNote('sage', true, true, { chrome: [CHROME_ID], codexApp: [] }).value,
    inAppBrowserNote('sage', false, true).value,
    inAppBrowserNote('sage', false, false).value,
  ];
  for (const note of notes) assert.doesNotMatch(note, FAMILY_GET);
  for (const note of notes.slice(0, 6)) {
    assert.match(note, /agent\.browsers\.list\(\)/);
    assert.match(note, /not supported in Owl/);
    const run = programOf(note);
    for (const list of [
      [owl, chrome, iab],
      [chrome, owl, iab],
    ])
      assert.equal(await run(fakeAgent(list)), chrome);
  }
  // without Chrome there is no Chrome selection to describe
  for (const note of notes.slice(6)) assert.doesNotMatch(note, /Selecting Chrome/);
  // ids MoPilot read are named, and decide even when the plugin has no profile names
  const named = chromeSelectionNote({ chrome: [CHROME_ID], codexApp: [OWL_ID] });
  assert.match(named, new RegExp(`user's Chrome has extensionInstanceId ${CHROME_ID}`));
  assert.match(named, new RegExp(`own browser has ${OWL_ID}; never use it as Chrome`));
  const bare = { ...chrome, profileName: undefined };
  assert.equal(await programOf(named)(fakeAgent([owl, bare])), bare);
  // nothing qualifies: the program says Chrome is not connected, rather than failing on a missing entry
  await assert.rejects(
    programOf(chromeSelectionNote())(fakeAgent([owl, bare])),
    /The user's Chrome is not connected to the Browser plugin/,
  );
  // its helpers live inside one function: the only top-level name is the chrome binding, so it can run again in the REPL
  const program = /binding\): (const chrome = [\s\S]*?\}\)\(\);)/.exec(named)![1];
  assert.match(program, /^const chrome = await \(async \(\) => \{ const pick = function pickChromeBackend\(/);
  assert.match(program, /\}\)\(\);$/);
  assert.doesNotMatch(chromeSelectionNote(), /extensionInstanceId [0-9a-f]{8}-/);
});

/** A Local Extension Settings folder for the ChatGPT extension under `profileDir`, with its leveldb files. */
function settings(profileDir: string, files: Record<string, string>) {
  const dir = path.join(profileDir, 'Local Extension Settings', CHATGPT_EXTENSION_ID);
  fs.mkdirSync(dir, { recursive: true });
  for (const [name, text] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), Buffer.from(text, 'latin1'));
  return dir;
}
/** A leveldb log record as Chrome writes it: key, a length byte, the JSON string value. */
const record = (id: string) => `\u0001\u0013extensionInstanceId&"${id}"\u0000junk`;

test('CM-W03: extension instance discovery orders large LevelDB file sequences exactly', () => {
  const files: any = {
    readdirSync: () => ['9007199254740992.log', '9007199254740993.ldb'],
    readFileSync: (file: string) => Buffer.from(record(file.endsWith('993.ldb') ? CHROME_ID : OWL_ID), 'latin1'),
  };
  assert.equal(readInstanceId(files, '/profile'), CHROME_ID);
});

test('CM-W03: MoPilot reads the extension instance ids of Chrome profiles and of the Codex app’s in-app browser', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'owl-'));
  try {
    const support = path.join(home, 'Library', 'Application Support');
    const OTHER = '0a1b2c3d-0000-4000-8000-000000000001';
    settings(path.join(support, 'Google', 'Chrome', 'Default'), { '000003.log': record(CHROME_ID), CURRENT: 'MANIFEST' });
    // a second profile: the newest file wins, and a later record in a file overrides an earlier one
    settings(path.join(support, 'Google', 'Chrome', 'Profile 2'), {
      '000005.ldb': record(OWL_ID),
      '000009.log': `${record(OWL_ID)}${record(OTHER.toUpperCase())}`,
    });
    settings(path.join(support, 'Google', 'Chrome', 'System Profile'), { '000003.log': record(OWL_ID) });
    // a profile whose files hold no id yet
    settings(path.join(support, 'Google', 'Chrome', 'Profile 3'), { '000001.log': 'empty', LOG: 'x' });
    settings(path.join(support, 'Codex', 'Default', 'Partitions', 'codex-browser-app'), { '000003.log': record(OWL_ID) });
    fs.mkdirSync(path.join(support, 'Codex', 'Default', 'Partitions', 'empty'), { recursive: true });
    assert.deepEqual(chatgptExtensionInstances({ home, platform: 'darwin' }), { chrome: [CHROME_ID, OTHER], codexApp: [OWL_ID] });
    // the Codex app's partitions are read on macOS only; nothing installed reads as no ids
    assert.deepEqual(chatgptExtensionInstances({ home, platform: 'linux' }), { chrome: [], codexApp: [] });
    assert.deepEqual(chatgptExtensionInstances({ home: path.join(home, 'nobody'), platform: 'darwin' }), NONE);
    assert.deepEqual(chatgptExtensionInstances({ home, platform: 'freebsd' }).codexApp, []);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
  assert.equal(instanceIdIn('no id here'), null);
  assert.equal(instanceIdIn(`extensionInstanceId&"not-a-uuid"`), null);
  // a file compacted away between listing and reading, then one that says it
  const gone: any = {
    readdirSync: () => ['000004.log', '000002.ldb', 'LOG'],
    readFileSync: (p: string) => {
      if (p.endsWith('000004.log')) throw Object.assign(new Error('gone'), { code: 'ENOENT' });
      return Buffer.from(record(CHROME_ID), 'latin1');
    },
  };
  assert.equal(readInstanceId(gone, '/x'), CHROME_ID);
  const unreadable: any = {
    readdirSync: () => {
      throw Object.assign(new Error('denied'), { code: 'EACCES' });
    },
  };
  assert.equal(readInstanceId(unreadable, '/x'), null);
  assert.deepEqual(chatgptExtensionInstances({ fs: unreadable, home: '/h', platform: 'darwin' }), NONE);
  // this Mac's home and platform by default
  assert.deepEqual(chatgptExtensionInstances({ fs: unreadable }), NONE);
});

/** A native Codex thread loaded through the injection, with the given tools and extension ids. */
function nativeThread(o: any) {
  const inj = new CodexToolInjection({
    sessions: new ToolSessions(),
    command: '/bin/sage-mcp',
    socketPath: '/tmp/s.sock',
    harnessPid: () => 1,
    nativeEnabled: () => true,
    ...o,
  });
  const sent = inj.outgoing({ id: 1, method: 'thread/start', params: {} });
  inj.observe({ id: 1, result: { thread: { id: 'th' } } });
  const server = Object.keys(sent.params.config.mcp_servers).find((n) => n.startsWith('sage_'))!;
  return { inj, server };
}

test('CM-W04: every native Codex thread with Chrome is told how to select it, with the ids MoPilot read', () => {
  const known = { chrome: [CHROME_ID], codexApp: [OWL_ID] };
  // with browser_* tools: the routing note carries the selection, naming the ids
  const routed = nativeThread({ visibleTools: () => ['browser_navigate'], chromeInstances: () => known });
  const value = routed.inj.turnContext('th').context.value;
  assert.equal(value, `${scopeNote(routed.server)}\n\n${inAppBrowserNote(routed.server, true, false, known).value}`);
  assert.match(value, new RegExp(CHROME_ID));
  assert.doesNotMatch(value, FAMILY_GET);
  // without browser_* tools the selection note still goes out
  const bare = nativeThread({ visibleTools: () => ['desktop_click'], chromeInstances: () => known });
  assert.equal(bare.inj.turnContext('th').context.value, chromeSelectionNote(known));
  // ids that can't be read: the note names none
  const failing = nativeThread({
    visibleTools: () => [],
    chromeInstances: () => {
      throw new Error('denied');
    },
  });
  assert.equal(failing.inj.turnContext('th').context.value, chromeSelectionNote(null));
  // no native Chrome: no ids are read and nothing is said about Chrome
  let read = 0;
  const noChrome = nativeThread({
    visibleTools: () => [],
    nativeSurfaces: () => ({ chrome: false, computer: true }),
    chromeInstances: () => (read++, known),
  });
  assert.equal(noChrome.inj.turnContext('th'), null);
  assert.equal(read, 0);
  // a sub-agent thread's turns are Codex's own: no note of its own
  routed.inj.observe({ method: 'thread/started', params: { thread: { id: 'sub-1', parentThreadId: 'th' } } });
  assert.equal(routed.inj.isNativeThread('sub-1'), true);
  assert.equal(routed.inj.turnContext('sub-1'), null);
});

test('CM-W05: the Owl refusal of a Codex Chrome tab reads as the Codex app’s browser with a next step, not dropped', () => {
  const p = skyProblemOfItem({
    type: 'mcpToolCall',
    server: 'cua_repl',
    status: 'failed',
    result: { content: [{ type: 'text', text: 'Error: Creating browser windows from extensions is not supported in Owl.' }] },
  });
  assert.equal(p?.kind, 'codexAppBrowser');
  assert.match(p!.title, /Codex app's browser/);
  assert.match(p!.hint!, /quit the ChatGPT app, or remove the ChatGPT extension/);
  assert.equal(p!.message, 'Error: Creating browser windows from extensions is not supported in Owl.');
});

test('CM-W07: MoPilot serves Codex its Chrome backend when the plugin lists Chrome as "chrome" (26.1007+) or "extension" (older), and native availability reads both', () => {
  const { mainChromeBackends } = require('../electron/capabilities/browser/chromeBackend.cjs');
  const { pluginListsChrome } = require('../electron/capabilities/browser/chromeControl.cjs');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-w07-'));
  try {
    const dir = path.join(home, '.codex', 'plugins', 'cache', 'openai-bundled', 'unified-computer-use', '26.1007.41230');
    fs.mkdirSync(dir, { recursive: true });
    const plugin = (backends: string) =>
      fs.writeFileSync(
        path.join(dir, '.mcp.json'),
        JSON.stringify({ mcpServers: { cua_repl: { env: { BROWSER_USE_AVAILABLE_BACKENDS: backends } } } }),
      );
    const live: any = { chromeRelay: { tabs: { t: 1 }, grants: {} }, controller: { chatOf: (id: string) => id } };
    // Codex's default where the build ships the extension, with the chrome_* tools off (CM-Z33)
    const flags = new Set(['codex.browser.chromeExtension', 'native.codex.enabled']);
    const m = mainChromeBackends({
      live,
      server: { proc: { pid: 1 } },
      isFlagEnabled: (k: string) => flags.has(k),
      shellEnv: { childEnv: () => ({}) },
      home,
      shipped: true,
    });
    // what the ChatGPT app's 26.1007 plugin lists: its extension-type backends are keyed "chrome"
    plugin('chrome,iab,mcpapps');
    assert.equal(m.available(), true);
    // what older plugins listed
    plugin('iab,extension');
    assert.equal(m.available(), true);
    // a plugin that serves no Chrome
    plugin('iab,mcpapps');
    assert.equal(m.available(), false);
    // the same rule decides whether the plugin enables its Chrome surface
    assert.deepEqual(
      [['chrome'], ['extension'], ['iab', 'mcpapps'], []].map((b) => pluginListsChrome(b)),
      [true, true, false, false],
    );
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});
