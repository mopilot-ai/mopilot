// User-requested IAB retention guidance and the existing mark lifecycle, through the public tool and native Codex contracts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { setup, drive, tabOf } from './support/browser-host-kit.ts';
import { browserToolSpecs } from './support/tool-specs.ts';

const require = createRequire(import.meta.url);
const { createBrowserTools } = require('../electron/capabilities/browser/hostTools.cjs');
const { OriginGrants } = require('../electron/capabilities/browser/origins.cjs');
const { placement, nameRewriter, rewriteSchema } = require('../electron/capabilities/contract/hostServers.cjs');
const { inAppBrowserNote, notesWithoutBrowserTools } = require('../electron/capabilities/channels/codexThreadContracts.cjs');
const { NAME: IAB_NAME, UPLOAD_HINT } = require('../electron/capabilities/browser/iabBackend/protocol.cjs');
const { createChromeTools } = require('../electron/capabilities/browser/chromeTools.cjs');
const { chromeBackendNote } = require('../electron/capabilities/browser/chromeBackend.cjs');
const { surfaceNote, registryNote, claudeNames } = require('../electron/capabilities/contract/surfaceNote.cjs');

test('every IAB retention route explains page-opened tabs and windows from temporary tabs', () => {
  const specs = browserToolSpecs();
  const popup = /tabs or windows (?:that )?pages open from (?:these |a )?temporary tabs?/;
  for (const name of ['browser_navigate', 'browser_tabs_context', 'browser_tabs_create', 'browser_tabs_mark', 'browser_script'])
    assert.match(specs.find((s: any) => s.name === name).description, popup, name);
  assert.match(specs.find((s: any) => s.name === 'browser_tabs_mark').description, /Unmarked temporary tabs close at turn end/);
  for (const spec of specs.filter((s: any) => s.inputSchema.properties.tabId && !s.inputSchema.required?.includes('tabId')))
    assert.match(spec.inputSchema.properties.tabId.description, popup, spec.name);
  for (const text of [inAppBrowserNote('sage_test', true, true).value, notesWithoutBrowserTools(null, null, true).join('\n')])
    assert.match(text, popup);
});

test('shared session notes explain IAB retention once using only the visible mark, under each harness name', () => {
  const names = ['browser_tabs_mark', 'browser_read_page', 'chrome_navigate'];
  for (const naming of [undefined, claudeNames('sage_test')]) {
    const note = surfaceNote(names, { yourChrome: false, naming });
    const mark = naming ? 'mcp__mopilot_browser__tabs_mark' : 'browser_tabs_mark';
    assert.ok(note.includes('Tabs these tools open in the built-in browser'));
    assert.match(note, /implicit tabs.*tabs or windows pages open from temporary tabs/);
    assert.match(note, /unmarked tabs close when your turn ends, except the turn's result tab/);
    assert.ok(note.includes(`Use ${mark} with status "deliverable" on each tab`));
    assert.match(note, /user asks to keep for a later message before your turn ends and before promising/);
    assert.equal(note.split(mark).length, 2, 'the retention note names the available mark once');
    assert.doesNotMatch(note, /tabs_context|browser_navigate/, 'unavailable opener names are not invented');
    const chrome = note.split('\n').find((line: string) => line.includes("user's own Chrome"));
    assert.doesNotMatch(chrome, /mark|close|turn ends/);
  }
  assert.equal(
    registryNote({ list: () => names.map((name) => ({ name })) }, { drivesUserChrome: () => false }),
    surfaceNote(names, { yourChrome: false }),
    'managed Codex and ACP receive the shared Registry note',
  );
});

test('shared retention notes are absent without the visible IAB mark, including Chrome and legacy browser routes', () => {
  for (const names of [['browser_read_page'], ['chrome_navigate'], ['desktop_left_click'], ['sage_browser_click']])
    for (const yourChrome of [false, true])
      assert.doesNotMatch(surfaceNote(names, { yourChrome }), /Tabs these tools open|tabs_mark|markDeliverable|unmarked tabs close/);
  assert.equal(surfaceNote([], { yourChrome: false }), null);
});

test('IAB tools that open tabs explain temporary tabs and marking every requested tab before the turn ends', () => {
  const specs = browserToolSpecs();
  for (const name of ['browser_navigate', 'browser_tabs_context', 'browser_tabs_create']) {
    const spec = specs.find((s: any) => s.name === name);
    assert.match(spec.description, /temporary/);
    assert.match(spec.description, /unmarked tabs.*close.*turn ends/);
    assert.match(spec.description, /browser_tabs_mark.*deliverable/);
    assert.match(spec.description, /each tab.*user.*keep.*later message/);
    assert.match(spec.description, /before (?:your|the) turn ends/);
    assert.equal(spec.policy, 'observe');
  }
  const implicit = specs.filter((s: any) => s.inputSchema.properties.tabId && !s.inputSchema.required?.includes('tabId'));
  assert.ok(implicit.some((s: any) => s.name === 'browser_read_page'));
  for (const spec of implicit) {
    const hint = spec.inputSchema.properties.tabId.description;
    assert.match(hint, /opening a temporary tab if none exists/, spec.name);
    assert.match(hint, /Unmarked tabs.*close at turn end/, spec.name);
    assert.match(hint, /browser_tabs_mark.*deliverable.*each tab.*later message.*before your turn ends/, spec.name);
  }
  assert.match(specs.find((s: any) => s.name === 'browser_tabs_create').description, /duplicate/);
  const mark = specs.find((s: any) => s.name === 'browser_tabs_mark');
  assert.match(mark.description, /explicitly asks.*keep.*later message/);
  assert.match(mark.description, /before.*promis/);
  assert.match(mark.description, /"handoff": the user must continue in the tab themselves/);
  assert.deepEqual(mark.inputSchema.properties.status.enum, ['deliverable', 'handoff']);
  assert.deepEqual(mark.inputSchema.required, ['tabId', 'status']);
  assert.match(mark.inputSchema.properties.status.description, /later message/);
  assert.equal(mark.policy, 'observe');
});

test('browser_script describes the same retention for its implicit tab and tabs.new, using its own mark API', () => {
  const spec = browserToolSpecs().find((s: any) => s.name === 'browser_script');
  assert.match(spec.description, /implicitly.*tabs\.new.*temporary/);
  assert.match(spec.description, /unmarked tabs.*close.*turn ends/);
  assert.match(spec.description, /markDeliverable\(\).*each tab.*user.*keep.*later message/);
  assert.match(spec.description, /before (?:your|the) turn ends/);
  assert.match(spec.description, /markHandoff\(\).*user.*continue/);
});

test('Claude sees callable short names in the same retention descriptions and schema hints', () => {
  const specs = browserToolSpecs();
  const placed = new Map(specs.map((s: any) => [s.name, placement(s.name, 'sage_test')]));
  const rewrite = nameRewriter(placed)('mopilot_browser');
  for (const name of ['browser_navigate', 'browser_tabs_context', 'browser_tabs_create']) {
    const text = rewrite(specs.find((s: any) => s.name === name).description);
    assert.match(text, /tabs_mark.*deliverable/);
    assert.match(text, /later message/);
    assert.doesNotMatch(text, /browser_tabs_mark/);
  }
  const schema = rewriteSchema(specs.find((s: any) => s.name === 'browser_tabs_mark').inputSchema, rewrite);
  const pageSchema = rewriteSchema(specs.find((s: any) => s.name === 'browser_read_page').inputSchema, rewrite);
  assert.match(pageSchema.properties.tabId.description, /tabs_mark.*deliverable/);
  assert.doesNotMatch(pageSchema.properties.tabId.description, /browser_tabs_mark/);
  assert.match(schema.properties.status.description, /later message/);
  assert.deepEqual(schema.properties.status.enum, ['deliverable', 'handoff']);
});

test('native Codex receives a MoPilot-IAB-only retention note with or without browser tools, never for a Chrome-only route', () => {
  for (const { chrome, own } of [
    { chrome: true, own: null },
    { chrome: false, own: null },
    { chrome: true, own: chromeBackendNote('c') },
  ]) {
    const withTools = inAppBrowserNote('sage_test', chrome, true, null, own).value;
    const withoutTools = notesWithoutBrowserTools(own, chrome ? 'CHROME RULE' : null, true).join('\n');
    assert.equal(withTools.split(UPLOAD_HINT).length, 2, 'the existing upload guidance stays present exactly once');
    for (const text of [withTools, withoutTools]) {
      assert.ok(text.includes(`while its name is "${IAB_NAME}"`));
      assert.match(text, /for any other browser, ignore this paragraph/);
      assert.match(text, /markDeliverable\(\).*each tab.*user.*keep.*later message/);
      assert.match(text, /before (?:your|the) turn ends/);
    }
    assert.doesNotMatch(withoutTools, /browser_tabs_mark/);
    assert.doesNotMatch(inAppBrowserNote('sage_test', chrome, false, null, own).value, /markDeliverable/);
  }
  assert.doesNotMatch(notesWithoutBrowserTools('MOPILOT CHROME RULE', null, false).join('\n'), /markDeliverable/);
  assert.deepEqual(notesWithoutBrowserTools(null, 'VENDOR CHROME RULE', false), ['VENDOR CHROME RULE']);
});

/** Public tools over the real browser host; only Electron's pages and clock are faked. */
function toolHost(t: any) {
  const h = setup(t);
  const newWC = h.newWC;
  h.newWC = (opts: any) => {
    const wc = newWC(opts);
    wc.ops.tree = () => ({ lines: [], truncated: false });
    return wc;
  };
  const grants = new OriginGrants({ file: null, ask: async () => assert.fail('retaining a tab does not ask for a site grant') });
  const tools = createBrowserTools({ tabs: h.tabs, grants });
  const call = (name: string, args = {}, segmentId = 'claude-segment') =>
    drive(t, tools.find((s: any) => s.name === name).handler(args, { chatId: 'c', segmentId }));
  return { ...h, call };
}

test('Chrome tools keep their own tab descriptions and never offer the IAB-only mark', (t) => {
  const h = setup(t);
  const grants = new OriginGrants({ file: null });
  for (const tool of createChromeTools({ tabs: h.tabs, grants }))
    assert.doesNotMatch(JSON.stringify({ description: tool.description, schema: tool.schema }), /tabs_mark|markDeliverable|temporary tab/);
});

for (const opener of ['browser_tabs_context', 'browser_read_page'])
  test(`${opener}-created and explicitly created deliverables stay in the same chat across later segments and mark expiry`, async (t) => {
    const h = toolHost(t);
    await h.call(opener);
    const a = h.tabs.current('c');
    await h.call('browser_tabs_create');
    const b = h.tabs.current('c');
    assert.notEqual(a.id, b.id);
    for (const tab of [a, b]) {
      assert.equal(tab.created, true);
      await h.call('browser_tabs_mark', { tabId: tab.id, status: 'deliverable' });
    }
    assert.deepEqual(await drive(t, h.tabs.turnEnded('c')), { closed: [], kept: [a.id, b.id] });
    assert.ok([a, b].every((tab) => !tab.created && !tab.held && tab.openedByAgent));
    const next = await h.call('browser_tabs_context', {}, 'codex-segment');
    assert.ok(next[0].text.includes(a.id) && next[0].text.includes(b.id));
    await h.call('browser_tabs_select', { tabId: a.id }, 'codex-segment');
    assert.deepEqual(await drive(t, h.tabs.turnEnded('c')), { closed: [], kept: [a.id, b.id] });
    assert.deepEqual([a.mark, b.mark], [null, null], 'the marks expire; retained tabs remain ordinary chat tabs');
    assert.deepEqual(await drive(t, h.tabs.turnEnded('c')), { closed: [], kept: [a.id, b.id] });
    await h.call('browser_tabs_close', { tabId: a.id }, 'acp-segment');
    assert.deepEqual(
      h.tabs.list('c').map((tab: any) => tab.id),
      [b.id],
      'explicit close still wins',
    );
  });

test('unmarked scratch cleanup, user tabs, handoffs and another chat remain unchanged', async (t) => {
  const h = toolHost(t);
  const users = tabOf(h, null);
  await h.call('browser_tabs_create');
  const scratch = h.tabs.current('c');
  await h.call('browser_tabs_create');
  const handoff = h.tabs.current('c');
  await h.call('browser_tabs_mark', { tabId: handoff.id, status: 'handoff' });
  await h.call('browser_tabs_create');
  const result = h.tabs.current('c');
  const elsewhere = await drive(t, h.tabs.create('other'));
  const out = await drive(t, h.tabs.turnEnded('c'));
  assert.deepEqual(out, { closed: [scratch.id], kept: [users.id, handoff.id, result.id] });
  assert.equal(result.result, true);
  assert.equal(handoff.mark, 'handoff');
  assert.equal(elsewhere.closed, false);
  assert.equal(elsewhere.created, true, 'another chat is not swept');
});

for (const asTab of [false, true])
  for (const source of ['temporary', 'user', 'retained'])
    test(`page-opened ${asTab ? 'tabs' : 'windows'} inherit ${source} opener ownership; only unmarked temporary children close`, async (t) => {
      const h = toolHost(t);
      let opener;
      if (source === 'user') opener = tabOf(h, null);
      else {
        await h.call('browser_tabs_create');
        opener = h.tabs.current('c');
        if (source === 'retained') {
          await h.call('browser_tabs_mark', { tabId: opener.id, status: 'deliverable' });
          await drive(t, h.tabs.turnEnded('c'));
        }
      }
      const kept = h.tabs.adoptPopup(opener.wc, h.newWC({}), { asTab });
      const unmarked = h.tabs.adoptPopup(opener.wc, h.newWC({}), { asTab });
      assert.equal(kept.created, source === 'temporary');
      assert.equal(unmarked.created, source === 'temporary');
      assert.equal(kept.kind, asTab ? 'tab' : 'popup');
      if (source === 'temporary') await h.call('browser_tabs_mark', { tabId: kept.id, status: 'deliverable' });
      await drive(t, h.tabs.ready(opener, 'c'));
      const out = await drive(t, h.tabs.turnEnded('c'));
      assert.deepEqual(out.closed, source === 'temporary' ? [unmarked.id] : []);
      assert.equal(kept.closed, false);
      assert.equal(unmarked.closed, source === 'temporary');
      assert.equal(kept.created, false);
      assert.deepEqual((await drive(t, h.tabs.turnEnded('c'))).closed, []);
      assert.equal(kept.mark, null, 'mark expiry does not turn a retained child back into a temporary one');
    });
