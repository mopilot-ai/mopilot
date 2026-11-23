// Vendor-native browser and computer steps read as what they did (src/lib/agentNarration.ts): Claude in
// Chrome, the Claude desktop computer-use server, and Codex's cua_repl JavaScript programs, through the
// adapter registry keyed by tool namespace. MoPilot's own browser_*/desktop_* tools are covered in
// agentNarration.test.ts; this file covers the adapters and the program reader.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';

const narrationUrl = new URL('../src/lib/agentNarration.ts', import.meta.url).href;
registerHooks({
  resolve(s, c, next) {
    if (c.parentURL === narrationUrl && s === './toolOutput')
      return { shortCircuit: true, url: new URL('../src/lib/toolOutput.ts', import.meta.url).href };
    return next(s, c);
  },
});
const { controlStep, controlSource, controlThumbnail, narrationContext, registerControlAdapter } = await import(narrationUrl);

const PNG = 'iVBORw0KGgo=';
/** A finished MCP call as Claude Code (server + tool) or ACP (an mcp__ name) reports it. */
const call = (server: string | undefined, tool: string, args: any = {}, text = '', extra: any[] = []) => ({
  type: 'mcpToolCall',
  server,
  tool,
  arguments: args,
  status: 'completed',
  result: { content: [...(text ? [{ type: 'text', text }] : []), ...extra] },
});
const chrome = (tool: string, args: any = {}, text = '') => controlStep(call('claude-in-chrome', tool, args, text));
const cu = (tool: string, args: any = {}, text = '') => controlStep(call('computer-use', tool, args, text));
/** A Codex native program (cua_repl `js`). */
const js = (code: unknown, title?: unknown, extra: any[] = []) => call('cua_repl', 'js', { code, title }, '', extra);
const script = (code: unknown, ctx?: any, title?: unknown) => controlStep(js(code, title), ctx);
const done = (code: string, ctx?: any) => script(code, ctx)!.done;

/* ---------- Claude in Chrome ---------- */

test('Claude in Chrome: every tool reads as what it did, from the server name or an mcp__ name', () => {
  assert.deepEqual(chrome('navigate', { url: 'https://example.com/a' }), {
    surface: 'browser',
    done: 'Opened example.com',
    doing: 'Opening example.com',
  });
  // ACP reports the full mcp__ name with no server; the namespace is compared without case or separators
  assert.equal(controlStep(call(undefined, 'mcp__claude-in-chrome__navigate', { url: 'a.test' }))!.done, 'Opened a.test');
  assert.equal(controlStep(call('Claude in Chrome', 'find', { query: 'Pricing' }))!.done, 'Looked for “Pricing”');
  assert.equal(controlStep(call('Claude_Browser', 'get_page_text'))!.done, 'Read the page text');
  assert.equal(chrome('computer', { action: 'left_click', coordinate: [3, 4] })!.done, 'Clicked the page');
  assert.equal(chrome('computer', { action: 'type', text: 'x'.repeat(24) })!.done, 'Typed 24 characters');
  assert.equal(chrome('computer', { action: 'screenshot' })!.doing, 'Taking a screenshot');
  assert.equal(chrome('read_page')!.done, 'Read the page');
  assert.equal(chrome('form_input', { ref: 'ref_1', value: 'a' })!.done, 'Filled in a form field');
  assert.equal(chrome('tabs_context_mcp')!.done, 'Checked the open tabs');
  assert.equal(chrome('tabs_create_mcp')!.done, 'Opened a new tab');
  assert.equal(chrome('tabs_close_mcp')!.done, 'Closed a tab');
  assert.equal(chrome('javascript_tool', { action: 'javascript_exec', text: '1' })!.done, 'Ran JavaScript on the page');
  assert.equal(chrome('file_upload', { paths: ['/a'] })!.done, 'Uploaded 1 file');
  assert.equal(chrome('upload_image')!.done, 'Uploaded an image');
  assert.equal(chrome('upload_image')!.doing, 'Uploading an image');
  assert.equal(chrome('gif_creator', { action: 'start_recording' })!.done, 'Started recording the page');
  assert.equal(chrome('gif_creator', { action: 'stop_recording' })!.done, 'Stopped recording the page');
  assert.equal(chrome('gif_creator', { action: 'export' })!.done, 'Saved a recording of the page');
  assert.equal(chrome('gif_creator', {})!.done, 'Recorded the page');
  assert.equal(chrome('shortcuts_list')!.done, 'Checked the browser shortcuts');
  assert.equal(chrome('shortcuts_execute')!.done, 'Ran a browser shortcut');
  assert.equal(chrome('list_connected_browsers')!.done, 'Checked the connected browsers');
  assert.equal(chrome('select_browser')!.done, 'Switched browsers');
  assert.equal(chrome('switch_browser')!.doing, 'Switching browsers');
  assert.equal(chrome('request_credentials')!.done, 'Asked for sign-in details');
  assert.equal(chrome('list_granted_credentials')!.done, 'Checked the sign-ins it may use');
  assert.equal(chrome('autofill_credential')!.done, 'Filled in a saved sign-in');
  assert.equal(chrome('release_credentials')!.done, 'Let go of sign-in details');
  assert.equal(chrome('enter_verification_code')!.done, 'Entered a verification code');
  assert.equal(chrome('preview_start')!.done, 'Started a preview');
  assert.equal(chrome('preview_list')!.done, 'Checked the previews');
  assert.equal(chrome('preview_logs')!.done, 'Read the preview logs');
  assert.equal(chrome('preview_stop')!.done, 'Stopped a preview');
  assert.equal(chrome('something_new')!.done, 'Used the browser');
});

test('form fills: a fill_form with fields and a batch of form inputs count their fields; other batches count actions', () => {
  assert.equal(chrome('fill_form', { fields: [{}, {}, {}] })!.done, 'Filled 3 fields');
  assert.equal(chrome('fill_form', { fields: [{}] })!.doing, 'Filling 1 field');
  assert.equal(chrome('fill_form', { fields: [] })!.done, 'Filled in a form field');
  const inputs = { actions: [{ name: 'form_input' }, { name: 'form_input' }, { name: 'fill_form' }] };
  assert.equal(chrome('browser_batch', inputs)!.done, 'Filled 3 fields');
  assert.equal(chrome('browser_batch', inputs)!.doing, 'Filling 3 fields');
  assert.equal(chrome('browser_batch', { actions: [...inputs.actions, { name: 'find' }] })?.done, 'Filled in a field, found in 4 steps');
  assert.equal(chrome('browser_batch', { actions: [null] })!.done, 'Ran 1 browser action');
  assert.equal(chrome('browser_batch', { actions: [] })!.done, 'Ran 0 browser actions');
});

test("Claude in Chrome: a screenshot result is the step's thumbnail; a page script is its code", () => {
  const shot = call('claude-in-chrome', 'computer', { action: 'screenshot' }, '', [
    { type: 'image', source: { type: 'base64', media_type: 'image/png', data: PNG } },
  ]);
  assert.equal(controlThumbnail(shot), `data:image/png;base64,${PNG}`);
  assert.deepEqual(controlSource(call('claude-in-chrome', 'javascript_tool', { text: 'document.title' })), {
    code: 'document.title',
    lang: 'javascript',
  });
  assert.equal(controlSource(call('claude-in-chrome', 'javascript_tool', { text: 5 })), null);
  assert.equal(controlSource(call('claude-in-chrome', 'navigate', { url: 'a' })), null);
});

/* ---------- Claude desktop computer use ---------- */

test('computer-use server: shared desktop actions, and per-app tools name their app', () => {
  assert.deepEqual(cu('left_click', {}, '{"app":"Finder"}'), {
    surface: 'desktop',
    done: 'Clicked in Finder',
    doing: 'Clicking in Finder',
    app: 'Finder',
  });
  assert.equal(cu('app_click', { app: 'Notes' })!.done, 'Clicked in Notes');
  assert.equal(cu('app_type', { app: 'Notes', text: 'hey' })!.done, 'Typed 3 characters in Notes');
  assert.equal(cu('app_drag', { app: '' })!.done, 'Dragged on the screen');
  assert.equal(cu('computer_batch', { actions: [{}, {}] })!.done, 'Ran 2 desktop actions');
  assert.equal(cu('app_focus', { app: 'Mail' })!.done, 'Switched to Mail');
  assert.equal(cu('app_focus')!.doing, 'Switching to an app');
  assert.equal(cu('app_menu', { app: 'Mail' })!.done, 'Used a menu in Mail');
  assert.equal(cu('app_menu')!.doing, 'Using a menu');
  assert.equal(cu('app_list_windows', { app: 'Mail' })!.done, 'Checked the windows in Mail');
  assert.equal(cu('app_list_windows')!.doing, 'Checking the windows');
  assert.equal(cu('app_ax_find', { app: 'Mail' })!.done, 'Looked for an element in Mail');
  assert.equal(cu('app_ax_find')!.doing, 'Looking for an element');
  assert.equal(cu('app_bring_to_current_space', { app: 'Mail' })!.done, 'Brought Mail to this space');
  assert.equal(cu('app_bring_to_current_space')!.doing, 'Bringing an app to this space');
  assert.equal(cu('app_release', { app: 'Mail' })!.done, 'Let go of Mail');
  assert.equal(cu('release_full_control')!.doing, 'Letting go of your computer');
  assert.equal(cu('list_apps')!.done, 'Checked the open apps');
  assert.equal(cu('list_apps')!.doing, 'Checking the open apps');
  assert.equal(cu('request_full_control')!.done, 'Asked for full control');
  assert.equal(cu('request_full_control')!.doing, 'Asking for full control');
  assert.equal(cu('teach_step')!.done, 'Showed you around');
  assert.equal(cu('request_teach_access')!.doing, 'Showing you around');
  assert.equal(cu('teach_batch')!.done, 'Showed you around');
});

/* ---------- Codex native: cua_repl programs ---------- */

test('cua_repl: opening pages and tabs names the host', () => {
  assert.deepEqual(script('let tab = await cua.createBrowserTab("chrome", "https://example.com/login", { visible: true });'), {
    surface: 'browser',
    done: 'Opened example.com',
    doing: 'Opening example.com',
  });
  assert.equal(done('await cua.createBrowserTab("https://a.test/x")'), 'Opened a.test');
  assert.equal(done('await cua.createBrowserTab("iab")'), 'Opened a new tab');
  assert.equal(done('await cua.createBrowserTab()'), 'Opened a new tab');
  assert.equal(done("await tab.goto('https://b.test/p')"), 'Opened b.test');
  assert.equal(done('await tab.goto(url)'), 'Opened a page');
  assert.equal(script('await page.goto(url)')!.doing, 'Opening a page');
  assert.equal(done('await browser.newTab("https://c.test")'), 'Opened c.test');
  assert.equal(done('await browser.newPage()'), 'Opened a new tab');
  assert.equal(done('await browser.createTab()'), 'Opened a new tab');
  assert.equal(done('await tab.reload()'), 'Reloaded the page');
  assert.equal(done('await tab.goBack()'), 'Went back');
  assert.equal(done('await tab.goForward()'), 'Went forward');
  assert.equal(done('let t = await cua.getTab({ url: "https://d.test/" }, { browser: "1" })'), 'Switched to d.test');
  assert.equal(done('let t = await cua.getTab(5)'), 'Switched tabs');
});

test('cua_repl: Playwright locators name the element acted on', () => {
  assert.equal(done("await tab.playwright.getByRole('button', { name: 'Submit' }).click();"), 'Clicked “Submit”');
  assert.equal(done("await tab.playwright.getByRole('link').click()"), 'Clicked a link');
  assert.equal(done("await tab.playwright.getByRole('button', { name: label }).click()"), 'Clicked a button');
  assert.equal(done('await tab.playwright.getByRole(role).click()'), 'Clicked an element');
  assert.equal(done("await tab.playwright.getByText('Next').dblclick()"), 'Double-clicked “Next”');
  assert.equal(done('await tab.playwright.getByText(label).click()'), 'Clicked an element');
  assert.equal(done("await tab.playwright.getByLabel('Email').fill('a@b.c')"), 'Filled “Email”');
  assert.equal(done("await tab.playwright.locator('[name=\"password\"]').fill('x')"), 'Filled “password”');
  assert.equal(done("await tab.playwright.locator('#zip').fill('1')"), 'Filled “zip”');
  assert.equal(done("await tab.playwright.locator('text=Sign in').click()"), 'Clicked “Sign in”');
  assert.equal(done('await tab.playwright.locator(\'button:has-text("Buy")\').click()'), 'Clicked “Buy”');
  assert.equal(done("await tab.playwright.locator('div.card > a').hover()"), 'Hovered over “div.card > a”');
  // a chain over several lines, comments and escaped quotes
  assert.equal(
    done("await tab.playwright // the form\n  .getByPlaceholder('Search \\'all\\'')\n  /* type it */ .pressSequentially('hello')"),
    "Typed 5 characters into “Search 'all'”",
  );
  assert.equal(done("await tab.playwright.getByLabel('Note').fill('line\\nbreak')"), 'Filled “Note”');
  assert.equal(done("await tab.playwright.locator('#agree').check()"), 'Checked “agree”');
  assert.equal(done("await tab.playwright.locator('#agree').uncheck()"), 'Unchecked “agree”');
  assert.equal(done("await tab.playwright.locator('#agree').setChecked(false)"), 'Unchecked “agree”');
  assert.equal(done('await tab.playwright.locator(sel).setChecked(true)'), 'Checked a box');
  assert.equal(done('await box.setChecked()'), 'Checked a box');
  assert.equal(done("await tab.playwright.getByLabel('Country').selectOption('NZ')"), 'Chose an option in “Country”');
  assert.equal(script('await tab.selectOption(3)')!.doing, 'Choosing an option');
  assert.equal(done("await tab.playwright.getByRole('textbox', { name: 'Name' }).press('Enter')"), 'Pressed Enter');
  assert.equal(done('await tab.playwright.mouse.wheel(0, 400)'), 'Scrolled');
  assert.equal(done("await tab.playwright.locator('a').dragTo(target)"), 'Dragged on the page');
  assert.equal(done('await tab.hover()'), 'Hovered over an element');
});

test('cua_repl: several fills are one fill; other extra steps are counted; reads, screenshots and waits are not', () => {
  assert.equal(
    done(
      "await tab.playwright.getByLabel('A').fill('1');\nawait tab.playwright.getByLabel('B').fill('2');\nawait tab.playwright.getByLabel('C').fill('3');",
    ),
    'Filled 3 fields',
  );
  assert.equal(done("await app.setValue(1, 'a'); await app.setValue(2, 'b')"), 'Filled 2 fields');
  assert.equal(
    done("await tab.goto('https://a.test'); await tab.playwright.getByText('Next').click(); await tab.screenshot({ fullPage: false });"),
    'Opened a.test and 1 more step',
  );
  assert.equal(
    script("await tab.goto('https://a.test'); await tab.click(1); await tab.click(2)")!.doing,
    'Opening a.test and 2 more steps',
  );
  assert.equal(
    done("await tab.goto('https://a.test'); nodeRepl.write(await tab.playwright.domSnapshot()); await tab.playwright.waitForTimeout(500)"),
    'Opened a.test',
  );
  assert.equal(
    done("await tab.playwright.keyboard.type('hello world'); await tab.playwright.keyboard.press('Enter')"),
    'Typed 11 characters and 1 more step',
  );
  // equal ranks: the first one leads
  assert.equal(done("await tab.click(1); await tab.playwright.getByText('B').click()"), 'Clicked an element and 1 more step');
});

test('cua_repl: page-side code is one "Ran JavaScript" step, not its own clicks', () => {
  assert.equal(
    done("const r = await tab.playwright.evaluate(() => { document.querySelector('a').click(); return 1; }); nodeRepl.write(r)"),
    'Ran JavaScript on the page',
  );
  assert.equal(done("await tab.playwright.$eval('a', (e) => e.click())"), 'Ran JavaScript on the page');
  assert.equal(done("await tab.playwright.$$eval('a', (e) => e.map((x) => x.click()))"), 'Ran JavaScript on the page');
  assert.equal(done('await tab.playwright.evaluateHandle(() => window)'), 'Ran JavaScript on the page');
  assert.equal(done("await tab.playwright.waitForFunction(() => document.querySelector('x').click())"), 'Waited for the page');
});

test('cua_repl: tab housekeeping, reads and inventory', () => {
  assert.equal(done('await tab.markHandoff()'), 'Handed the tab over to you');
  assert.equal(done('await tab.close()'), 'Closed a tab');
  assert.equal(done('await tab.screenshot()'), 'Took a screenshot');
  assert.equal(done('nodeRepl.write(await tab.getAXState())'), 'Read the page');
  for (const m of ['domSnapshot', 'ariaSnapshot', 'textContent', 'innerText', 'allTextContents', 'allInnerTexts', 'inputValue'])
    assert.equal(done(`await tab.playwright.locator('x').${m}()`), 'Read the page', m);
  for (const m of ['waitForSelector', 'waitForLoadState', 'waitForURL'])
    assert.equal(done(`await tab.playwright.${m}('x')`), 'Waited for the page', m);
  assert.equal(script('await page.waitForTimeout(1)')!.doing, 'Waiting for the page');
  assert.deepEqual(script('await cua.getState();'), {
    surface: 'desktop',
    done: 'Checked the open apps and tabs',
    doing: 'Checking the open apps and tabs',
  });
  assert.equal(done('await cua.listApps()'), 'Checked the open apps');
  assert.equal(script('await cua.listApps()')!.doing, 'Checking the open apps');
  assert.equal(done('await cua.listBrowsers()'), 'Checked the browsers');
  assert.equal(script('await cua.listBrowsers()')!.doing, 'Checking the browsers');
  assert.equal(done('await cua.listTabs({ browser: "1" })'), 'Checked the open tabs');
  assert.equal(script('await cua.listTabs()')!.doing, 'Checking the open tabs');
  assert.equal(script('let b = await cua.getBrowser({ id: "1" })')!.surface, 'browser');
  assert.equal(done('let b = await cua.getBrowser({ id: "1" })'), 'Connected to the browser');
  assert.equal(script('await cua.getBrowser()')!.doing, 'Connecting to the browser');
});

test('cua_repl: desktop app actions name the app the program (or an earlier one) bound', () => {
  assert.deepEqual(script('let app = await cua.getApp("Notes");\nnodeRepl.write(await app.getAXState());'), {
    surface: 'desktop',
    done: 'Read the Notes window',
    doing: 'Reading the Notes window',
    app: 'Notes',
  });
  assert.equal(done('let app = await cua.getApp("Notes")'), 'Opened Notes');
  assert.equal(script('let app = await cua.getApp(name)')!.doing, 'Opening an app');
  assert.equal(done('let app = await cua.getApp("Notes"); await app.click(12)'), 'Clicked in Notes');
  assert.equal(done('let app = await cua.getApp("Notes"); await app.performSecondaryAction(3)'), 'Right-clicked in Notes');
  assert.equal(done('let app = await cua.getApp("Notes"); await app.type("abc")'), 'Typed 3 characters in Notes');
  assert.equal(done('let app = await cua.getApp("Notes"); await app.pressKey("cmd+s")'), 'Pressed ⌘S in Notes');
  assert.equal(done('let app = await cua.getApp("Notes"); await app.setValue(4, "x")'), 'Filled a field in Notes');
  assert.equal(done('let app = await cua.getApp("Notes"); await app.scroll(2, "down")'), 'Scrolled in Notes');
  assert.equal(done('let app = await cua.getApp("Notes"); await app.drag(1, 2)'), 'Dragged in Notes');
  assert.equal(done('let app = await cua.getApp("Notes"); await app.hover(1)'), 'Hovered over Notes');
  assert.equal(done('let app = await cua.getApp("Notes"); await app.close()'), 'Closed Notes');
  assert.equal(done('let app = await cua.getApp("Notes"); await app.getScreenshot()'), 'Captured screen in Notes');
  // a variable copied from a bound one keeps its app
  assert.equal(done('let app = await cua.getApp("Notes"); win = await app.window(); await win.click(1)'), 'Clicked in Notes');
  // without a binding: the variable's name or the method decides the surface; no app is named
  assert.equal(done('await app.click(12)'), 'Clicked on the screen');
  assert.equal(done('await thing.performSecondaryAction(1)'), 'Right-clicked on the screen');
  assert.equal(done('await myApp.type("ab")'), 'Typed 2 characters');
  assert.equal(done('await myApp.type(text)'), 'Typed 0 characters');
  assert.equal(done('await myApp.pressKey("a")'), 'Pressed A');
  assert.equal(done('await myApp.press()'), 'Pressed a key');
  assert.equal(done('await myApp.drag()'), 'Dragged on the screen');
  assert.equal(done('await myApp.hover()'), 'Hovered over the screen');
  assert.equal(done('await myApp.close()'), 'Closed a window');
  assert.equal(done('await myApp.getAXState()'), 'Read the screen');
  assert.equal(done('await myApp.getAXStateAndScreenshot()'), 'Captured screen');
  // an action whose receiver says nothing takes the surface and app of the program's other actions
  assert.deepEqual(script('await thing.click(1); await cua.listTabs()'), {
    surface: 'browser',
    done: 'Clicked an element',
    doing: 'Clicking an element',
  });
  assert.equal(done('let notes = await cua.getApp("Notes"); await thing.click(1); await notes.getAXState()'), 'Clicked in Notes');
  // an unknown receiver with no hint: a desktop step
  assert.equal(script('await thing.click(1)')!.surface, 'desktop');
  assert.equal(done('await thing.tap(1)'), 'Clicked on the screen');
});

test('cua_repl: bindings from earlier programs carry over through narrationContext', () => {
  const ctx = narrationContext([
    js('let bartender = await cua.getApp("Bartender 5")'),
    js('let permitTab = await cua.createBrowserTab("chrome", "https://permits.test")'),
    js('second = permitTab'),
    js(42),
    call('claude-in-chrome', 'navigate', { url: 'https://x.test' }),
    { type: 'commandExecution' },
  ]);
  // a plain alias names the same tab (shared/cuaProgram.mjs, as main's desktop lock reads it)
  assert.deepEqual([...ctx.keys()], ['bartender', 'permitTab', 'second']);
  assert.equal(ctx.get('second')?.surface, 'browser');
  assert.equal(done('await bartender.click(3)', ctx), 'Clicked in Bartender 5');
  assert.equal(
    done("await bartender.click(3); await bartender.setValue(5, 'hello')", ctx),
    'Filled a field in Bartender 5 and 1 more step',
  );
  assert.equal(script('await permitTab.click(6)', ctx)!.surface, 'browser');
  // a program it cannot read takes the surface of what it uses, or the model's own title
  assert.deepEqual(script('nodeRepl.write(await helper(bartender))', ctx), {
    surface: 'desktop',
    done: 'Ran a computer-use script',
    doing: 'Running a computer-use script',
    app: 'Bartender 5',
  });
  assert.deepEqual(script('nodeRepl.write(await helper(permitTab)); await other()', ctx), {
    surface: 'browser',
    done: 'Ran a browser script (2 steps)',
    doing: 'Running a browser script (2 steps)',
  });
  assert.deepEqual(script('nodeRepl.write(JSON.stringify(foo))', undefined, '  Check the form  '), {
    surface: 'desktop',
    done: 'Check the form',
    doing: 'Check the form',
  });
  assert.equal(script('nodeRepl.write(1)', undefined, '   ')!.done, 'Ran a computer-use script');
  assert.equal(script('await x; await y; await z;')!.done, 'Ran a computer-use script (3 steps)');
  // the model's title never replaces an action it recognises
  assert.equal(script("await tab.goto('https://a.test')", undefined, 'Open it')!.done, 'Opened a.test');
});

test('cua_repl: malformed programs still narrate rather than throw', () => {
  assert.equal(script(undefined)!.done, 'Ran a computer-use script');
  assert.equal(done("await tab.goto('https://a.test"), 'Opened a.test'); // an unterminated string
  assert.equal(done('await tab.goto("'), 'Opened a page'); // a lone quote at the end
  assert.equal(done('await tab.playwright.getByText("x").click('), 'Clicked “x”'); // never closed
  assert.equal(done('/* never closed'), 'Ran a computer-use script');
  assert.equal(done('// only a comment'), 'Ran a computer-use script');
  assert.equal(done('await tab.goto("a.test", { waitUntil: "load" }, )'), 'Opened a.test');
  assert.equal(done('await [tab][0].click(1)'), 'Clicked on the screen');
  assert.equal(done('x = a ? tab.click(1) : 0'), 'Clicked an element');
  assert.equal(controlStep(call('cua_repl', 'js', 'not an object'))!.done, 'Ran a computer-use script');
});

test("cua_repl: its other tools, its code as the step's source, and its screenshots as thumbnails", () => {
  assert.deepEqual(controlStep(call('cua_repl', 'js_reset')), {
    surface: 'desktop',
    done: 'Reset the control session',
    doing: 'Resetting the control session',
  });
  assert.deepEqual(controlStep(call('cua_repl', 'turn_ended')), {
    surface: 'desktop',
    done: 'Let go of your computer',
    doing: 'Letting go of your computer',
  });
  assert.equal(controlStep(call('cua_repl', 'other')), null);
  assert.deepEqual(controlSource(js('await cua.getState()')), { code: 'await cua.getState()', lang: 'javascript' });
  assert.equal(controlSource(js(5)), null);
  assert.equal(controlSource(call('cua_repl', 'js_reset')), null);
  assert.equal(
    controlThumbnail(js('await tab.screenshot()', undefined, [{ type: 'image', data: PNG, mimeType: 'image/png' }])),
    `data:image/png;base64,${PNG}`,
  );
});

test("browser_script: read like a native program, always on the browser, from any harness's namespace; its code is the source", () => {
  const codex = (code: unknown) => call('sage_0123456789ab', 'browser_script', { code });
  const claude = (code: unknown) => call('mopilot_browser', 'browser_script', { code });
  const acp = (code: unknown) => call(undefined, 'mcp__sage_acp__browser_script', { code });
  const form =
    'await tab.goto("https://example.com/signup")\nawait tab.getByLabel("Email").fill("a@b.co")\nawait tab.getByLabel("Name").fill("A")\nawait tab.getByRole("button", { name: "Create" }).click()';
  assert.deepEqual(controlStep(codex(form)), {
    surface: 'browser',
    done: 'Opened example.com and 3 more steps',
    doing: 'Opening example.com and 3 more steps',
  });
  assert.equal(
    controlStep(
      claude('await tab.getByLabel("Email").fill("x")\nawait tab.getByPlaceholder("City").fill("y")\nawait tab.locator("#zip").fill("z")'),
    )!.done,
    'Filled 3 fields',
  );
  assert.equal(controlStep(acp('await tab.getByRole("link", { name: "Pricing" }).click()'))!.done, 'Clicked “Pricing”');
  // nothing it recognises: still a browser script, never the desktop
  assert.deepEqual(controlStep(codex('const a = 1\nawait sleep(5)\nawait sleep(5)')), {
    surface: 'browser',
    done: 'Ran a browser script (2 steps)',
    doing: 'Running a browser script (2 steps)',
  });
  assert.equal(controlStep(claude(42))!.done, 'Ran a browser script');
  assert.deepEqual(controlSource(codex('await tab.title()')), { code: 'await tab.title()', lang: 'javascript' });
  assert.equal(controlSource(claude(5)), null);
});

test("mopilot_browser: Claude Code's short-named in-app browser tools read as the browser_* tools do", () => {
  const claude = (tool: string, args: any = {}) => controlStep(call('mopilot_browser', tool, args));
  assert.deepEqual(claude('navigate', { url: 'https://a.test/x' }), { surface: 'browser', done: 'Opened a.test', doing: 'Opening a.test' });
  assert.equal(claude('read_page')!.done, 'Read the page');
  assert.equal(claude('browser_batch', { actions: [{}, {}] })!.done, 'Ran 2 browser actions');
  assert.equal(controlStep(call(undefined, 'mcp__mopilot_browser__tabs_context'))!.done, 'Checked the open tabs');
  assert.equal(controlSource(call('mopilot_browser', 'navigate')), null);
});

test('the registry: other namespaces are not narrated; a new vendor plugs in by namespace', () => {
  assert.equal(controlStep(call('docs', 'search')), null);
  assert.equal(controlStep(call(undefined, 'search')), null);
  assert.equal(controlSource(call('docs', 'search')), null);
  assert.equal(controlSource(null), null);
  assert.equal(controlStep({ tool: '' }), null);
  registerControlAdapter(['Acme Browser', 'acme_browser_v2'], {
    narrate: (c: any) => (c.tool === 'go' ? { surface: 'browser', done: `Opened ${c.args.to}`, doing: `Opening ${c.args.to}` } : null),
  });
  assert.equal(controlStep(call('acme-browser', 'go', { to: 'a.test' }))!.done, 'Opened a.test');
  assert.equal(controlStep(call(undefined, 'mcp__acme_browser_v2__go', { to: 'b.test' }))!.done, 'Opened b.test');
  assert.equal(controlStep(call('acme-browser', 'other')), null);
  assert.equal(controlSource(call('acme-browser', 'go')), null);
  // MoPilot's own tools keep their name-based narration under any namespace
  assert.equal(controlStep(call('claude-in-chrome', 'browser_navigate', { url: 'a.test' }))!.done, 'Opened a.test');
});

/* ---------- Codex computer use (Sky) problems ---------- */

test("cua_repl: a failed step carries what Codex Computer Use reported, its message verbatim, with MoPilot's fix", () => {
  const failed = (tool: string, error: string) =>
    controlStep({
      ...call('cua_repl', tool, { code: "const app = await cua.getApp('Notes'); await app.click({ x: 1, y: 2 });" }),
      status: 'failed',
      result: null,
      error: { message: error },
    });
  const s = failed('js', 'Computer Use permissions are not granted')!;
  assert.equal(s.done, 'Clicked in Notes');
  assert.deepEqual(
    [s.problem!.kind, s.problem!.code, s.problem!.name, s.problem!.message],
    ['permissions', -10009, 'permissionsNotGranted', 'Computer Use permissions are not granted'],
  );
  assert.equal(s.problem!.actions[0].label, 'Open Accessibility settings');
  // a version Sky doesn't support; the cleanup tools too
  assert.equal(failed('turn_ended', 'Sky Computer Use API version mismatch: client=a server=b')!.problem!.kind, 'versionMismatch');
  // an unknown Sky failure is still a problem, shown raw
  const unknown = failed('js', 'SkyComputerUseError: brand new failure')!;
  assert.deepEqual([unknown.problem!.kind, unknown.problem!.message], ['unknown', 'SkyComputerUseError: brand new failure']);
  // an MCP error result counts as failed
  const isError = controlStep({
    ...call('cua_repl', 'js', { code: 'x' }),
    result: { content: [{ type: 'text', text: 'Codex Computer Use went away' }], isError: true },
  })!;
  assert.equal(isError.problem!.kind, 'unknown');
  // a successful program that printed Sky's error reports it; a failure that isn't Sky's carries none
  assert.equal(
    controlStep(call('cua_repl', 'js', { code: 'x' }, '{"errorName":"screenLocked","code":-10020}'))!.problem!.kind,
    'screenLocked',
  );
  assert.equal('problem' in failed('js', 'TypeError: app.click is not a function')!, false);
  assert.equal('problem' in controlStep(call('cua_repl', 'js', { code: 'x' }, 'Codex Computer Use is great'))!, false);
  // a cua_repl tool that isn't control stays unnarrated, whatever it reported
  assert.equal(failed('other', 'Computer Use permissions are not granted'), null);
  // other vendors never carry a Sky problem
  assert.equal(
    'problem' in
      controlStep({
        ...call('computer-use', 'screenshot'),
        status: 'failed',
        error: { message: 'Computer Use permissions are not granted' },
      })!,
    false,
  );
});

test("a vendor tool that sends the user to its own desktop app reads in MoPilot's words, on every vendor's adapter", () => {
  const ask = 'The extension is not connected. Please open the Claude app and try again.';
  for (const step of [chrome('navigate', { url: 'https://a.test' }, ask), cu('screenshot', {}, ask)]) {
    assert.equal(step!.problem!.kind, 'vendorApp');
    assert.equal(
      step!.problem!.message,
      'The extension is not connected. Try again in MoPilot. If it keeps failing, check Settings → Computer use.',
    );
    assert.deepEqual(
      step!.problem!.actions.map((a: any) => a.kind),
      ['retry', 'settings'],
    );
  }
  // Codex's computer use keeps its own Sky problem, in MoPilot's words too
  const sky = controlStep({ ...js('x'), status: 'failed', error: { message: 'Sky Computer Use host service failed. Relaunch ChatGPT.' } });
  assert.equal(sky!.problem!.kind, 'serviceUnavailable');
  assert.match(sky!.problem!.message, /Try again in MoPilot/);
  // any other result has no problem; a call no adapter reads is no step
  assert.equal(chrome('navigate', { url: 'https://a.test' }, 'Navigated')!.problem, undefined);
  assert.equal(controlStep(call('unknown-server', 'x', {}, ask)), null);
  assert.equal(controlStep(null), null);
});

test('a Claude in Chrome refusal rides on its step with a next step; a page that says the same does not', () => {
  const failed = (tool: string, text: string) =>
    controlStep({
      ...call('claude-in-chrome', tool, { url: 'https://a.test' }, text),
      result: { content: [{ type: 'text', text }], isError: true },
    });
  const blocked = failed('navigate', 'This site is not allowed due to safety restrictions.')!;
  assert.equal(blocked.surface, 'browser');
  assert.deepEqual([blocked.problem!.kind, blocked.problem!.title], ['siteBlocked', 'This site is blocked for browser control']);
  assert.match(blocked.problem!.hint!, /Bring another tab or page to the front/);
  assert.equal(failed('navigate', 'Navigation to this domain is not allowed')!.problem!.kind, 'browserDeclined');
  // the same words as the result of a navigation, and as page text read back
  assert.equal(chrome('navigate', { url: 'https://a.test' }, 'Navigation to this domain is not allowed')!.problem!.kind, 'browserDeclined');
  assert.equal(chrome('get_page_text', {}, 'This site is blocked by your organization’s policy.')!.problem, undefined);
  // an ordinary failure carries none; the vendor-app wording still reads in MoPilot's words
  assert.equal(failed('navigate', 'Invalid URL: x')!.problem, undefined);
  assert.equal(failed('navigate', 'Please open the Claude app.')!.problem!.kind, 'vendorApp');
});
