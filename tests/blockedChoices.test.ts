// Ways forward when control was refused (src/lib/blockedChoices.ts), the suggested next step (src/lib/nextStep.ts,
// Tab accepting it), the access card's sentence helpers (approvalLogic.ts), and OriginGrants.allowInChat.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const { blockedOf, latestBlocked, choiceLabel, followUpFor, askAgainMessage } = await import('../src/lib/blockedChoices.ts');
const { suggestNextStep, acceptsNextStep } = await import('../src/lib/nextStep.ts');
const { nameList, accessSentence, warningLine } = await import('../src/components/thread/approvalLogic.ts');
const require = createRequire(import.meta.url);
const { OriginGrants } = require('../electron/capabilities/browser/origins.cjs');

let seq = 0;
/** A tool item as each harness reports it: Claude Code/ACP MCP names, or a Codex dynamic tool name. */
const call = (tool: string, args: any = {}, text = '', o: { error?: boolean } = {}) => ({
  id: `i${++seq}`,
  type: 'mcpToolCall',
  tool,
  arguments: args,
  status: o.error ? 'failed' : 'completed',
  ...(o.error ? { error: { message: text } } : { result: { content: text ? [{ type: 'text', text }] : [] } }),
});
const refusal = (message: string, reason: string) => `${message}\n<refusal reason="${reason}" retryable="false">\nnext: x\n</refusal>`;

test('a browser refusal maps to the ways forward that apply, for every harness naming of the tool', () => {
  for (const tool of ['mcp__sage__browser_navigate', 'browser_navigate', 'sage.browser_navigate']) {
    const b = blockedOf(
      call(tool, { url: 'https://a.test/x' }, refusal('The user did not allow https://a.test.', 'site_permission_denied'), { error: true }),
    )!;
    assert.equal(b.surface, 'browser');
    assert.equal(b.reason, 'site_permission_denied');
    assert.equal(b.origin, 'https://a.test');
    assert.equal(b.text, 'You didn’t allow a.test.');
    assert.deepEqual(b.choices, ['allowSite', 'openInBrowser', 'takeOver']);
  }
  // the origin from the call's url when the message names none
  const ro = blockedOf(call('browser_click', { url: 'https://b.test/p' }, refusal('Read only here.', 'site_read_only')))!;
  assert.equal(ro.origin, 'https://b.test');
  assert.deepEqual(ro.choices, ['allowWrite', 'takeOver']);
  assert.equal(ro.text, 'b.test is read only in this chat.');
  // no site at all: only taking over is left
  const nosite = blockedOf(call('browser_type', {}, refusal('Password fields are refused.', 'password_field')))!;
  assert.equal(nosite.origin, null);
  assert.equal(nosite.text, 'This site needs you to sign in.');
  assert.deepEqual(nosite.choices, ['takeOver']);
  // a non-web URL is no site
  assert.equal(blockedOf(call('browser_click', { url: 'file:///x' }, refusal('x', 'user_declined')))!.origin, null);
  assert.equal(blockedOf(call('browser_click', { url: 'not a url' }, refusal('x', 'user_declined')))!.origin, null);
  // declined actions and sign-ins
  assert.deepEqual(blockedOf(call('browser_click', {}, refusal('on https://c.test.', 'action_declined')))!.choices, ['takeOver']);
  assert.deepEqual(blockedOf(call('browser_click', {}, refusal('https://c.test', 'signin_cancelled')))!.choices, [
    'takeOver',
    'openInBrowser',
  ]);
  // blocked risk classes and read-only chats: the reason only, never a way around it
  const blocked = blockedOf(
    call('browser_navigate', { url: 'http://169.254.169.254/' }, refusal('Cloud metadata endpoint', 'site_blocked')),
  )!;
  assert.deepEqual(blocked.choices, []);
  assert.equal(blocked.text, 'This site is blocked for browser control. Do this step yourself if you need it.');
  // a read-only chat: the one way on is changing its mode, which needs no site
  const readOnly = blockedOf(call('browser_click', {}, refusal('x', 'chat_read_only')))!;
  assert.deepEqual(readOnly.choices, ['changeMode']);
  assert.equal(choiceLabel('changeMode', readOnly), 'Change mode');
  // not a refusal, an unknown reason, or not a control tool
  assert.equal(blockedOf(call('browser_navigate', {}, 'Navigated t1 to https://a.test')), null);
  assert.equal(blockedOf(call('browser_navigate', {}, refusal('x', 'tab_limit'))), null);
  assert.equal(blockedOf(call('shell', {}, refusal('x', 'site_permission_denied'))), null);
  assert.equal(blockedOf(null), null);
  assert.equal(blockedOf({ tool: 'browser_click', arguments: null }), null);
});

test('a desktop refusal: apps the user did not allow, an app not granted, screen control refused', () => {
  const denied = JSON.stringify({
    granted: [],
    denied: [
      { app: 'TextEdit', reason: 'the user did not allow it' },
      { app: 'Me', reason: 'never' },
    ],
  });
  const a = blockedOf(call('mcp__mopilot_computer__desktop_request_access', { apps: ['TextEdit'] }, denied))!;
  assert.deepEqual(
    [a.surface, a.reason, a.apps, a.text, a.choices],
    ['desktop', 'app_denied', ['TextEdit'], 'You didn’t allow TextEdit.', ['allowApps', 'doItMyself']],
  );
  // a request that granted everything, or a result that is not JSON
  assert.equal(blockedOf(call('desktop_request_access', {}, JSON.stringify({ granted: [{ app: 'Notes' }] }))), null);
  assert.equal(blockedOf(call('desktop_request_access', {}, 'oops')), null);
  const ng = blockedOf(
    call('desktop_app_click', { app: 'Mail' }, "Mail isn't granted in this chat; call desktop_request_access first", { error: true }),
  )!;
  assert.deepEqual([ng.reason, ng.apps, ng.text], ['app_not_granted', ['Mail'], 'Mail isn’t allowed in this chat.']);
  // a read-only chat: computer use can only look, and the mode is the way on, as in the browser
  const ro = blockedOf(
    call('desktop_app_click', { app: 'Mail' }, 'This chat is in a read-only mode: desktop control can only look', { error: true }),
  )!;
  assert.deepEqual(
    [ro.reason, ro.choices, ro.text],
    ['chat_read_only', ['changeMode'], 'This chat is in a read-only mode: computer use can only look.'],
  );
  const sc = blockedOf(call('desktop_left_click', {}, "The user didn't allow MoPilot to control the screen", { error: true }))!;
  assert.deepEqual([sc.reason, sc.choices], ['screen_denied', ['allowScreen', 'doItMyself']]);
  // Claude Code sees MoPilot's desktop tools as mopilot_computer short names: the same refusals, the same choices
  const cc = blockedOf(call('mcp__mopilot_computer__request_access', { apps: ['TextEdit'] }, denied))!;
  assert.deepEqual([cc.surface, cc.reason, cc.apps], ['desktop', 'app_denied', ['TextEdit']]);
  const ccNotGranted = blockedOf(
    call('mcp__mopilot_computer__app_click', { app: 'Mail' }, "Mail isn't granted in this chat; call request_access first", {
      error: true,
    }),
  )!;
  assert.deepEqual([ccNotGranted.reason, ccNotGranted.apps], ['app_not_granted', ['Mail']]);
  const ccScreen = blockedOf(
    call('mcp__mopilot_computer__left_click', {}, "The user didn't allow MoPilot to control the screen", { error: true }),
  )!;
  assert.equal(ccScreen.reason, 'screen_denied');
  assert.equal(blockedOf(call('mcp__mopilot_computer__screenshot', {}, 'ok')), null);
  // another server's tool of the same name is not MoPilot's
  assert.equal(blockedOf(call('mcp__other_server__request_access', { apps: ['TextEdit'] }, denied)), null);
  assert.equal(blockedOf(call('desktop_screenshot', {}, 'ok')), null);
});

test('latestBlocked: only a turn that ends on a refused control step; a later step clears it', () => {
  const refused = call('browser_navigate', { url: 'https://a.test' }, refusal('x', 'site_permission_denied'), { error: true });
  const fine = call('browser_snapshot', {}, 'page');
  assert.equal(latestBlocked([fine, refused, { type: 'agentMessage', id: 'm' }])!.id, refused.id);
  assert.equal(latestBlocked([refused, fine]), null);
  assert.equal(latestBlocked([{ type: 'agentMessage', id: 'm' }]), null);
});

test('saved screen refusals from either app name retain their recovery choices across harnesses', () => {
  for (const brand of ['MoPilot', 'MoPilot Code']) {
    for (const tool of ['desktop_left_click', 'mcp__mopilot_computer__left_click', 'sage.desktop_left_click']) {
      const item = call(tool, {}, `The user didn't allow ${brand} to control the screen`, { error: true });
      const blocked = latestBlocked([item]);
      assert.equal(blocked?.reason, 'screen_denied', `${brand}: ${tool}`);
      assert.deepEqual(blocked?.choices, ['allowScreen', 'doItMyself']);
      assert.equal(choiceLabel('allowScreen', blocked!), 'Allow screen control');
    }
  }
});

test('choice labels and the follow-up each choice sends', () => {
  const site = blockedOf(call('browser_navigate', { url: 'https://a.test' }, refusal('x', 'site_permission_denied')))!;
  const apps1 = { ...site, surface: 'desktop' as const, apps: ['TextEdit'], origin: null };
  const apps2 = { ...apps1, apps: ['TextEdit', 'Notes'] };
  assert.deepEqual(
    (['allowSite', 'allowWrite', 'openInBrowser', 'takeOver', 'doItMyself', 'allowScreen'] as const).map((c) => choiceLabel(c, site)),
    ['Allow this site', 'Allow changes here', 'Open in your browser', 'I’ll take over', 'I’ll take over', 'Allow screen control'],
  );
  assert.equal(choiceLabel('allowApps', apps1), 'Allow TextEdit');
  assert.equal(choiceLabel('allowApps', apps2), 'Allow these apps');
  assert.equal(followUpFor('allowSite', site), 'I allowed a.test for this chat. Continue the task.');
  assert.equal(followUpFor('allowWrite', site), 'I allowed a.test to read and change pages for this chat. Continue the task.');
  assert.match(followUpFor('allowApps', apps2), /^You can use TextEdit, Notes now: ask for access again/);
  assert.match(followUpFor('allowScreen', apps1), /allow screen control this time/);
  // done: the user finished the step themselves
  assert.match(followUpFor('openInBrowser', site, true), /^I finished that step on a\.test in my own browser\./);
  assert.match(followUpFor('openInBrowser', { ...site, origin: null }, true), /on the site in my own browser/);
  assert.match(followUpFor('takeOver', site, true), /myself in the browser\. Check the page again/);
  assert.match(followUpFor('doItMyself', apps1, true), /Look at the screen again/);
  assert.equal(followUpFor('allowSite', { ...site, origin: null }), 'I allowed the site for this chat. Continue the task.');
  assert.equal(askAgainMessage(site), "Try a.test again: I'll answer when it asks for permission.");
  assert.equal(askAgainMessage({ ...site, origin: null }), "Try the site again: I'll answer when it asks for permission.");
});

test('the suggested next step, derived locally from the turn: unsaved documents, hand-offs, refusals, defaults', () => {
  assert.equal(suggestNextStep([]), null);
  assert.equal(suggestNextStep([{ type: 'agentMessage', id: 'm' }]), null);
  assert.equal(suggestNextStep([{ id: 'x', type: 'mcpToolCall', tool: 'desktop_screenshot', arguments: null }]), null);
  // a new TextEdit document, never saved: through the menu or the shortcut, in the background or on screen
  assert.equal(
    suggestNextStep([
      call('desktop_app_menu', { app: 'TextEdit', path: ['File', 'New'] }),
      call('desktop_app_type', { app: 'TextEdit', text: 'hi' }),
    ]),
    'Close the new TextEdit document without saving',
  );
  assert.equal(
    suggestNextStep([call('desktop_open_application', { app: 'Notes' }), call('desktop_key', { text: 'cmd+n' })]),
    'Close the new Notes document without saving',
  );
  assert.equal(
    suggestNextStep([call('desktop_app_key', { app: 'Pages', combo: 'Cmd + N' })]),
    'Close the new Pages document without saving',
  );
  // saved (or closed) afterwards: no such suggestion; the default for the app instead
  assert.equal(
    suggestNextStep([
      call('desktop_app_menu', { app: 'TextEdit', path: ['File', 'New'] }),
      call('desktop_app_menu', { app: 'TextEdit', path: ['File', 'Save…'] }),
    ]),
    'Check TextEdit again and tell me what changed',
  );
  assert.equal(
    suggestNextStep([call('desktop_key', { app: 'TextEdit', text: 'cmd+n' }), call('desktop_key', { text: 'cmd+s' })]),
    'Check TextEdit again and tell me what changed',
  );
  // a menu with no path, a key with no text: nothing learned
  assert.equal(
    suggestNextStep([call('desktop_app_menu', { app: 'Mail', list: 'File' }), call('desktop_key', { repeat: 2 })]),
    'Check Mail again and tell me what changed',
  );
  assert.equal(suggestNextStep([call('desktop_app_menu', { app: 'Mail', path: [] })]), 'Check Mail again and tell me what changed');
  // the user took the tab over mid-task: the next step is theirs to announce
  assert.equal(
    suggestNextStep([call('browser_get_page_text', {}, refusal('You took over this tab.', 'user_took_over'), { error: true })]),
    'Continue, I’m done in the browser',
  );
  // a page that did not load is tried again, not summarized
  assert.equal(
    suggestNextStep([call('browser_navigate', { url: 'http://localhost:9/' }, 'net::ERR_UNSAFE_PORT at http://localhost:9/')]),
    'Try localhost:9 again',
  );
  assert.equal(suggestNextStep([call('browser_navigate', { url: 'https://a.test/x' }, 'timed out', { error: true })]), 'Try a.test again');
  assert.equal(suggestNextStep([call('browser_navigate', { url: 'https://a.test/x' }, "Couldn't load this page")]), 'Try a.test again');
  // A native prediction cannot bring back an app refused by this turn, even when only its note is loaded.
  assert.equal(suggestNextStep([], [{ app: 'TextEdit', name: 'TextEdit' }], 'Try opening TextEdit.'), null);
  // an untrusted certificate fails the same way every time: no retry is suggested
  assert.equal(
    suggestNextStep(
      [
        call(
          'browser_navigate',
          { url: 'https://localhost:8791/' },
          "Couldn't load this page: its security certificate isn't trusted (ERR_CERT_AUTHORITY_INVALID).",
        ),
      ],
      [],
      'Try opening that page again.',
    ),
    null,
  );
  // Claude Code sees MoPilot's desktop tools as mopilot_computer: the same suggestions as desktop_*
  assert.equal(
    suggestNextStep([call('mcp__mopilot_computer__app_key', { app: 'TextEdit', combo: 'cmd+n' })]),
    'Close the new TextEdit document without saving',
  );
  assert.equal(
    suggestNextStep([
      call('mcp__mopilot_computer__app_key', { app: 'TextEdit', combo: 'cmd+n' }),
      call('mcp__mopilot_computer__app_menu', { app: 'TextEdit', path: ['File', 'Save…'] }),
    ]),
    'Check TextEdit again and tell me what changed',
  );
  assert.equal(
    suggestNextStep([
      call('mcp__mopilot_computer__app_click', { app: 'Calculator' }),
      call('mcp__mopilot_computer__key', { text: 'cmd+n' }),
    ]),
    'Close the new Calculator document without saving',
  );
  assert.equal(
    suggestNextStep([call('mcp__mopilot_computer__app_click', { app: 'Calculator' })]),
    'Check Calculator again and tell me what changed',
  );
  // a vendor's desktop tool (the Claude app's computer-use server) still names its app; an unknown server gives no suggestion
  assert.equal(
    suggestNextStep([call('mcp__computer-use__app_click', { app: 'Calculator' })]),
    'Check Calculator again and tell me what changed',
  );
  assert.equal(suggestNextStep([call('mcp__computer-use__app_click', {})]), null);
  assert.equal(suggestNextStep([call('mcp__other_server__app_click', { app: 'Calculator' })]), null);
  // a sign-in hand-off, or another hand-off
  assert.equal(
    suggestNextStep([call('browser_request_signin', { tabId: 't1', reason: 'GitHub' }, 'waiting')]),
    'Continue after I signed in',
  );
  assert.equal(
    suggestNextStep([call('browser_tabs_mark', { tabId: 't1', status: 'handoff' }, 'Marked t1 as handoff: confirm the payment')]),
    'Continue, I’m done in the browser',
  );
  // refusals
  assert.equal(suggestNextStep([call('browser_type', {}, refusal('x', 'password_field'))]), 'Continue after I signed in');
  assert.equal(suggestNextStep([call('browser_type', {}, refusal('x', 'signin_cancelled'))]), 'Continue after I signed in');
  assert.equal(
    suggestNextStep([call('browser_navigate', { url: 'https://a.test' }, refusal('x', 'site_permission_denied'))]),
    'Continue with the sites I allowed',
  );
  // the browser default names the last page's site; a browser step without a URL suggests nothing
  assert.equal(
    suggestNextStep([call('browser_navigate', { url: 'https://news.test/a' }, 'Navigated t1 to https://news.test/a')]),
    'Summarize what you found on news.test',
  );
  assert.equal(suggestNextStep([call('browser_snapshot', {}, 'page')]), null);
  assert.equal(suggestNextStep([call('browser_navigate', { url: '' }, 'x')]), null);
});

test('Tab, alone, on an empty composer accepts the suggestion', () => {
  const k = (key: string, mods: Partial<Record<'shiftKey' | 'altKey' | 'metaKey' | 'ctrlKey', boolean>> = {}) => ({
    key,
    shiftKey: false,
    altKey: false,
    metaKey: false,
    ctrlKey: false,
    ...mods,
  });
  assert.equal(acceptsNextStep(k('Tab'), '', 'Go on'), true);
  assert.equal(acceptsNextStep(k('Tab'), 'typed', 'Go on'), false);
  assert.equal(acceptsNextStep(k('Tab'), '', null), false);
  assert.equal(acceptsNextStep(k('Enter'), '', 'Go on'), false);
  for (const m of ['shiftKey', 'altKey', 'metaKey', 'ctrlKey'] as const)
    assert.equal(acceptsNextStep(k('Tab', { [m]: true }), '', 'Go on'), false);
});

test("the access card's sentence: apps listed compactly, extras, the takeover card, and one warning line", () => {
  assert.equal(nameList([]), '');
  assert.equal(nameList(['A']), 'A');
  assert.equal(nameList(['A', 'B']), 'A and B');
  assert.equal(nameList(['A', 'B', 'C']), 'A, B and C');
  assert.equal(nameList(['A', 'B', 'C', 'D', 'E']), 'A, B and 3 more');
  const app = (name: string, warning: string | null = null) => ({ bundleId: name, name, tier: 'full' as const, warning });
  assert.equal(
    accessSentence('Codex', { kind: 'computerAccessSet', harness: 'codex', apps: [app('TextEdit')] }),
    'Allow Codex to use TextEdit?',
  );
  assert.equal(
    accessSentence('Codex', {
      kind: 'computerAccessSet',
      harness: 'codex',
      apps: [app('A'), app('B'), app('C'), app('D')],
      clipboardWrite: true,
    }),
    'Allow Codex to use A, B and 2 more and write the clipboard?',
  );
  assert.equal(
    accessSentence('Gemini', { kind: 'computerAccessSet', harness: 'acp:gemini', systemKeyCombos: true }),
    'Allow Gemini to press whole-Mac shortcuts?',
  );
  assert.equal(
    accessSentence('Claude Code', { kind: 'computerTakeover', harness: 'claude' }),
    'Allow Claude Code to use your mouse and keyboard?',
  );
  // a teach tour: the agent walks the person through a task, with the reason cut to one line
  assert.equal(
    accessSentence('Claude Code', {
      kind: 'computerAccessSet',
      harness: 'claude',
      teach: true,
      reason: ' use Notes ',
      screenControl: true,
    }),
    'Allow Claude Code to guide you through use Notes?',
  );
  assert.equal(
    accessSentence('Codex', { kind: 'computerAccessSet', harness: 'codex', teach: true }),
    'Allow Codex to guide you through a task?',
  );
  assert.equal(
    accessSentence('Codex', { kind: 'computerAccessSet', harness: 'codex', teach: true, reason: 'x'.repeat(200) }),
    `Allow Codex to guide you through ${'x'.repeat(80)}?`,
  );
  assert.equal(warningLine([app('A')]), '');
  assert.equal(warningLine([app('A'), app('Terminal', 'can run any command')]), 'Terminal: can run any command');
  assert.equal(warningLine([app('Terminal', 'w1'), app('Finder', 'w2'), app('X', 'w3')]), 'Terminal: w1 (+2 more in Details)');
});

test('OriginGrants.allowInChat: forgets the denial and allows the site for the chat; high-risk only asks again; blocked never', async () => {
  const ctx = { chatId: 'c1', segmentId: 's1' };
  const g = new OriginGrants({ ask: async () => ({ decision: 'deny' }) });
  await assert.rejects(g.require('https://a.test/x', 'write', ctx), { code: 'denied' });
  assert.equal(g.peek('https://a.test/x', 'read', ctx), 'denied');
  assert.equal(g.allowInChat('c1', 'https://a.test', 'read'), 'allowed');
  assert.equal(g.peek('https://a.test/x', 'read', ctx), 'ok');
  assert.equal(g.peek('https://a.test/x', 'write', ctx), 'reask', 'read covers reading only: a write asks (#1319 G22)');
  assert.equal(g.peek('https://a.test/x', 'read', { chatId: 'c2', segmentId: 's' }), 'ask', "another chat isn't covered");
  assert.equal(g.list().length, 0, 'never a grant for good');
  assert.equal(g.allowInChat('c1', 'https://a.test', 'write'), 'allowed');
  assert.equal(g.peek('https://a.test/x', 'write', ctx), 'ok');
  // a wider grant stays when a narrower one is asked
  assert.equal(g.allowInChat('c1', 'https://a.test', 'read'), 'allowed');
  assert.equal(g.peek('https://a.test/x', 'write', ctx), 'ok');
  // a high-risk site: the denial is forgotten, but the next call asks with its risk card
  await assert.rejects(g.require('https://www.chase.com/', 'read', ctx), { code: 'denied' });
  assert.equal(g.allowInChat('c1', 'https://www.chase.com', 'read'), 'ask');
  assert.equal(g.peek('https://www.chase.com/', 'read', ctx), 'ask');
  // read only chosen on a card that asked to write: Allow changes here lifts it for the chat
  const lw = new OriginGrants({ ask: async () => ({ decision: 'allow', scope: 'once', level: 'read' }) });
  await assert.rejects(lw.require('https://w.test/', 'write', ctx), { code: 'read_only' });
  assert.equal(lw.peek('https://w.test/', 'write', ctx), 'read_only');
  assert.equal(lw.allowInChat('c1', 'https://w.test', 'write'), 'allowed');
  assert.equal(lw.peek('https://w.test/', 'write', ctx), 'ok');
  // blocked, bad input
  assert.equal(g.allowInChat('c1', 'http://169.254.169.254', 'read'), false);
  assert.equal(g.allowInChat('c1', 'https://a.test/path', 'read'), false);
  assert.equal(g.allowInChat('c1', 'https://a.test', 'admin'), false);
  assert.equal(g.allowInChat('', 'https://a.test', 'read'), false);
  assert.equal(g.allowInChat(undefined, 'https://a.test', 'read'), false);
});

test('the access card names the machine when the chat’s desktop is not this Mac’s', () => {
  const app = (name: string) => ({ bundleId: `x.${name}`, name, tier: 'full' as const });
  const base = { kind: 'computerAccessSet' as const, harness: 'codex' as const, apps: [app('Notes')] };
  assert.equal(accessSentence('Codex', { ...base, machine: 'box' }), 'Allow Codex to use Notes on box?');
  assert.equal(accessSentence('Codex', base), 'Allow Codex to use Notes?');
  assert.equal(
    accessSentence('Codex', { ...base, apps: [], clipboardRead: true, machine: 'box' }),
    'Allow Codex to read the clipboard on box?',
  );
  assert.equal(
    accessSentence('Codex', { ...base, kind: 'computerTakeover', machine: 'box' }),
    'Allow Codex to use the mouse and keyboard in Notes on box?',
  );
  assert.equal(accessSentence('Codex', { ...base, kind: 'computerTakeover' }), 'Allow Codex to use your mouse and keyboard in Notes?');
});
