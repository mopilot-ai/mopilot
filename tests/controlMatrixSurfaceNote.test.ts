// The control matrix (docs/control-plane/matrix.md), one note on what MoPilot's tools reach, on every harness
// (#1319 G3): a Claude Code session (its system prompt, under the names Claude sees), a managed Codex thread (its
// turn/start context, once per load) and an ACP session (ahead of its first prompt, which has no system prompt) are
// told which tools reach the built-in browser, the user's Chrome and the Mac's apps, from the tools they are shown.
// Case ids (CM-X..) start every title. The note, the Registry, the Claude tool channel and AcpTurns are real; the
// SDK, the harnesses and the browser channel are fakes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fakeSdk } from './support/control-matrix-kit.ts';

export const GUARDS = ['electron/', 'shared/'];

const require = createRequire(import.meta.url);
const { surfaceNote, registryNote, claudeNames } = require('../electron/capabilities/contract/surfaceNote.cjs');
const { inAppBrowserNote } = require('../electron/capabilities/channels/codexThreadContracts.cjs');
const { CodexToolInjection } = require('../electron/capabilities/channels/codexConfig.cjs');
const { Registry } = require('../electron/capabilities/contract/registry.cjs');
const { ToolSessions } = require('../electron/capabilities/contract/session.cjs');
const { prepareSessionTools } = require('../electron/harness/claude/sessionTools.cjs');
const { AcpTurns } = require('../electron/harness/acpTurns.cjs');

const ALL = [
  'browser_navigate',
  'browser_tabs_context',
  'browser_script',
  'sage_browser_click',
  'chrome_navigate',
  'desktop_request_access',
  'desktop_left_click',
  'desktop_app_click',
];

function registry(names: string[]) {
  const r = new Registry();
  for (const name of names)
    r.register({ name, description: name, schema: { type: 'object', properties: {} }, policy: 'observe', handler: async () => 'ok' });
  return r;
}

test('CM-X10: the note names each browser by what it is and when to use it, from the tools shown, and says which tools reach apps', () => {
  const both = surfaceNote(ALL, { yourChrome: false });
  assert.match(
    both,
    /built-in browser, MoPilot's browser pane .*: the browser_\* tools \(start with browser_navigate\); for many steps, prefer one browser_script call/,
  );
  assert.match(both, /user's own Chrome, where they are signed in: the chrome_\* tools/);
  assert.match(both, /share no pages, cookies or sign-ins/);
  assert.match(
    both,
    /call desktop_request_access for the apps first; the desktop_app_\* tools work in an app in the background, and the other desktop_\* tools take over the screen/,
  );
  // browser_* off (parity off): sage_browser_* drive the pane with the built-in channel, the user's Chrome with Your Chrome
  assert.match(surfaceNote(['sage_browser_click'], { yourChrome: false }), /built-in browser.*the sage_browser_\* tools/);
  const yours = surfaceNote(['sage_browser_click', 'computer_click'], { yourChrome: true });
  assert.match(yours, /user's own Chrome.*the sage_browser_\* tools/);
  assert.doesNotMatch(yours, /built-in browser/);
  assert.match(yours, /Apps on this Mac: the computer_\* tools/);
  // only what a session is shown: without a Chrome tool, the note says plainly there is none (#1483, CM-Z32); nothing at
  // all without these tools
  assert.doesNotMatch(surfaceNote(['browser_navigate'], { yourChrome: false }), /chrome_|share no pages/);
  assert.match(surfaceNote(['desktop_left_click'], { yourChrome: false }), /the other desktop_\* tools take over/);
  assert.equal(surfaceNote(['sage_debug_echo'], { yourChrome: false }), null);
  // from the Registry and the browser channel; none without a Registry
  assert.match(registryNote(registry(['browser_navigate']), { drivesUserChrome: () => false }), /browser_\* tools/);
  // Chrome chosen where MoPilot's extension serves it: the chrome_* tools are for web tasks by default
  const preferred = registryNote(registry(['browser_navigate', 'chrome_navigate']), {
    drivesUserChrome: () => false,
    userChrome: () => 'preferred',
  });
  assert.match(preferred, /The user chose Chrome in Settings: use them for web tasks unless the user means the built-in browser\./);
  assert.doesNotMatch(preferred, /Use them only when the user means their Chrome/);
  assert.match(registryNote(registry(['sage_browser_click']), null), /built-in browser/);
  assert.equal(registryNote(null, null), null);
});

test('CM-X11: a Claude Code session is told as its first tool server’s MCP instructions, under the names it sees, with the preset prompt left as it is', async () => {
  const sdk = { tool: fakeSdk.tool, createSdkMcpServer: (o: any) => o };
  const run = async (o: { nativeChrome?: boolean; yourChrome?: boolean; names?: string[] } = {}) => {
    const reg = registry(o.names ?? ALL);
    const hideTool = Object.assign((n: string) => o.nativeChrome === true && n.startsWith('chrome_'), { message: () => 'hidden' });
    const state: any = {
      sdk: async () => sdk,
      sageTools: {
        registry: reg,
        sessions: new ToolSessions(),
        enabled: () => true,
        hideTool,
        ...(o.yourChrome != null ? { yourChrome: () => o.yourChrome } : {}),
      },
    };
    const prompt = { type: 'preset', preset: 'claude_code', ...(o.nativeChrome ? { append: 'CHROME TIPS' } : {}) };
    const options: any = { systemPrompt: { ...prompt } };
    const s = { nativeChrome: !!o.nativeChrome };
    await prepareSessionTools(state, { takesPluginDirs: () => false }, '/cli', options, s, { chatId: 'c1' }, 'k1', () => 'c1');
    // the preset prompt (and Claude in Chrome's tips) are left as they are
    assert.deepEqual(options.systemPrompt, prompt);
    const servers = Object.values(options.mcpServers ?? {}) as any[];
    // only the first server carries the note
    assert.ok(servers.slice(1).every((x) => x.instructions === undefined));
    return servers[0]?.instructions as string | undefined;
  };
  const plain = await run({ yourChrome: false });
  assert.match(plain!, /the mcp__mopilot_browser__\* tools \(start with mcp__mopilot_browser__navigate\)/);
  assert.match(plain!, /the mcp__mopilot_chrome__\* tools/);
  assert.match(plain!, /call mcp__mopilot_computer__request_access .* the mcp__mopilot_computer__app_\* tools/);
  // with Claude in Chrome the session isn't shown MoPilot's Chrome tools: the note names none, and doesn't say the
  // session has no way to the user's Chrome (Claude in Chrome is that way, CM-Z32)
  const inChrome = (await run({ nativeChrome: true }))!;
  assert.doesNotMatch(inChrome, /mopilot_chrome|no tool in this chat acts in it/);
  // without Claude in Chrome and without MoPilot's Chrome tools, it does say so
  assert.match((await run({ names: ['browser_navigate'] }))!, /no tool in this chat acts in it/);
  // no tools these lines describe: no instructions
  assert.equal(await run({ names: ['sage_debug_echo'] }), undefined);
});

test('CM-X12: an ACP session is sent the note as a block for the model only, ahead of its first prompt in this app run, once', async () => {
  const sent: any[] = [];
  const turns = new AcpTurns({
    send: async (_c: string, key: string, payload: any) => (
      sent.push({ key, blocks: payload.blocks, display: payload.display }), { turnId: `t${sent.length}` }
    ),
    rename: () => {},
    readImage: async () => null,
    named: () => true,
    home: '/home/me',
    toolsNote: () => 'NOTE',
  });
  const ref = { kind: 'acp:opencode', id: 'o1', key: 'acp:opencode:o1' };
  await turns.startTurn('acp:opencode:o1', ref, { text: 'open the page' });
  await turns.startTurn('acp:opencode:o1', ref, { text: 'now click it' });
  const other = { kind: 'acp:gemini', id: 'g1', key: 'acp:gemini:g1' };
  await turns.startTurn('chat-2', other, { text: 'go', opts: { prefix: 'HANDOFF' } });
  // the note is its own block (annotations.audience), ahead of what the user typed and a switch's hand-off
  const NOTE = { type: 'text', text: 'NOTE', annotations: { audience: ['assistant'] } };
  assert.deepEqual(
    sent.map((s) => s.blocks),
    [
      [NOTE, { type: 'text', text: 'open the page' }],
      [{ type: 'text', text: 'now click it' }],
      [NOTE, { type: 'text', text: 'HANDOFF\n\ngo' }],
    ],
  );
  // what the chat shows is what the user typed
  assert.match(JSON.stringify(sent[0].display), /open the page/);
  assert.doesNotMatch(JSON.stringify(sent[0].display), /NOTE/);
  // a send that fails is sent the note again next time; a chat with no note gets none
  const failing = new AcpTurns({
    send: async () => {
      throw new Error('offline');
    },
    rename: () => {},
    readImage: async () => null,
    toolsNote: () => 'NOTE',
  });
  await failing.startTurn('c', ref, { text: 'x' });
  assert.equal(failing.noted.size, 0);
  const none = new AcpTurns({
    send: async (_c: string, _k: string, p: any) => (sent.push({ blocks: p.blocks }), {}),
    rename: () => {},
    readImage: async () => null,
    named: () => true,
  });
  await none.startTurn('c', ref, { text: 'plain' });
  assert.deepEqual(sent.at(-1).blocks, [{ type: 'text', text: 'plain' }]);
});

test("CM-X13: every harness is told that MoPilot's card confirms payment details in the pane, so it doesn't ask twice; outside the pane it still asks (#1384)", () => {
  const card = /MoPilot shows the user its own confirmation card, naming what is pressed, in every permission mode/;
  // G10 shortened the wording; each rule is the same: the card is the confirmation, never asked twice, and outside it the model asks
  const once =
    /That card is the user's confirmation: when they asked you to buy, take the step and let the card ask; don't also ask in chat or hand the tab over\. If they deny the card, stop and tell them\./;
  const outside =
    /Only those actions in the pane are covered: for a payment with no card form or payment provider's frame in view, page JavaScript you run to submit a form, or a browser or app outside the pane, confirm with the user first/;
  const notes: Record<string, string> = {
    // Claude Code, under the names it sees
    'Claude Code': surfaceNote(['browser_click'], { yourChrome: false, naming: claudeNames('sage_1') }),
    // a managed Codex thread and an ACP session: the Registry's names
    'managed Codex / ACP': registryNote(registry(['browser_click']), { drivesUserChrome: () => false }),
    // the older built-in tools on the pane
    'sage_browser_* on the pane': surfaceNote(['sage_browser_click'], { yourChrome: false }),
    // a native Codex thread, with and without the plugin's iab backend on MoPilot's pane
    'native Codex, iab': inAppBrowserNote('sage', true, true).value,
    'native Codex, browser_* only': inAppBrowserNote('sage', false, false).value,
  };
  for (const [who, note] of Object.entries(notes)) {
    for (const re of [card, once, outside]) assert.match(note, re, who);
    assert.match(note, /stop and tell them/, who);
  }
  // it names the tools that act in the pane, as each session sees them
  assert.match(notes['Claude Code'], /typing through the mcp__mopilot_browser__\* tools enters or submits payment details/);
  assert.match(notes['native Codex, iab'], /through the browser_\* tools or the plugin's "iab" browser/);
  // a native thread shown no browser_* tools (the VM's and the dev app's): the plugin's iab browser is the pane, so it is told
  // there too, tied to the name the plugin shows for MoPilot's pane; the Chrome note before it stays as it was
  const native = (o: any) => {
    const inj = new CodexToolInjection({
      sessions: new ToolSessions(),
      command: '/bin/sage-mcp',
      socketPath: '/tmp/s.sock',
      harnessPid: () => 1,
      nativeEnabled: () => true,
      visibleTools: () => [],
      chromeInstances: () => null,
      ...o,
    });
    inj.outgoing({ id: 1, method: 'thread/start', params: {} });
    inj.observe({ id: 1, result: { thread: { id: 'th' } } });
    return inj.turnContext('th')?.context.value ?? null;
  };
  const iab = { available: () => true, has: (id: string) => id === 'th', loaded: () => null };
  const plain = native({ browserBackends: iab });
  for (const re of [card, once, outside]) assert.match(plain, re, 'native Codex, iab without browser_*');
  assert.match(
    plain,
    /Payments in the Browser plugin's "iab" browser while its name is "MoPilot In-app Browser" \(MoPilot's pane; for any other browser, ignore this paragraph\)/,
  );
  assert.match(plain, /^Selecting Chrome in the Browser plugin/);
  const own = native({ browserBackends: iab, chromeNote: () => 'OWN CHROME NOTE' });
  assert.match(own, /^OWN CHROME NOTE\n\nPayments in the Browser plugin's "iab" browser/);
  // only the pane: no iab backend for the thread, and no Chrome either, says nothing
  assert.equal(native({ nativeSurfaces: () => ({ chrome: false, computer: true }) }), null);
  assert.equal(native({ nativeSurfaces: () => ({ chrome: false, computer: true }), browserBackends: { ...iab, has: () => false } }), null);
  // no pane among the tools (Your Chrome drives sage_browser_*, or only apps): no payment line at all
  assert.doesNotMatch(surfaceNote(['sage_browser_click'], { yourChrome: true }), /Payments in the built-in browser/);
  assert.doesNotMatch(surfaceNote(['chrome_navigate', 'desktop_left_click'], { yourChrome: false }), /Payments/);
});

test('CM-X14: every harness is told that bot checks and CAPTCHAs are never solved but handed to the user, with browser_request_signin where it is shown, else in chat (#1615, E-S4b)', () => {
  const rule =
    /Bot checks and CAPTCHAs \("I'm not a robot", "Verify you are human", reCAPTCHA, hCaptcha, Cloudflare Turnstile, picture or slider puzzles\), in any browser or app: never click, type into or solve one yourself\./;
  const refused = /MoPilot's browser tools refuse an action on one they recognize\./;
  const signin =
    /hand the tab to the user with (\S+) \(reason "Complete the CAPTCHA"\) and end your turn; read the page again when the user is done; in another browser or app, ask the user in chat to complete it\./i;
  const inChat = /Ask the user in chat to complete it, then continue\./;
  const withSignin: Record<string, string> = {
    'Claude Code': surfaceNote(['browser_click', 'browser_request_signin'], { yourChrome: false, naming: claudeNames('sage_1') }),
    'managed Codex / ACP': registryNote(registry(['browser_click', 'browser_request_signin']), { drivesUserChrome: () => false }),
    'native Codex, iab': inAppBrowserNote('sage', true, true).value,
    'native Codex, browser_* only': inAppBrowserNote('sage', false, false).value,
  };
  for (const [who, note] of Object.entries(withSignin)) {
    for (const re of [rule, refused, signin]) assert.match(note, re, who);
  }
  // under the name each session sees
  assert.equal(signin.exec(withSignin['Claude Code'])?.[1], 'mcp__mopilot_browser__request_signin');
  assert.equal(signin.exec(withSignin['managed Codex / ACP'])?.[1], 'browser_request_signin');
  // no hand-off tool shown (the older tools, Your Chrome, only apps): the user is asked in chat
  for (const names of [['sage_browser_click'], ['chrome_navigate'], ['desktop_left_click'], ['browser_click']]) {
    const note = surfaceNote(names, { yourChrome: false });
    assert.match(note, rule, names[0]);
    assert.match(note, inChat, names[0]);
  }
  // a native thread shown no browser_* tools on a browser MoPilot serves: after its other notes, asked in chat
  const { notesWithoutBrowserTools } = require('../electron/capabilities/channels/codexThreadContracts.cjs');
  const notes = notesWithoutBrowserTools('OWN', null, true);
  assert.match(notes.at(-1), rule);
  assert.match(notes.at(-1), inChat);
  assert.match(notesWithoutBrowserTools('OWN', null, false).at(-1), rule);
  // the vendor's own Chrome only (no MoPilot browser): its rules, not MoPilot's
  assert.deepEqual(notesWithoutBrowserTools(null, 'CHROME RULE', false), ['CHROME RULE']);
  assert.deepEqual(notesWithoutBrowserTools(null, null, false), []);
});
