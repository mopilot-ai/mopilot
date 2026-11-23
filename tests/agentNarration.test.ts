// Browser and desktop control narration (src/lib/agentNarration.ts) and the pane's view of agent tabs
// (src/lib/agentTabs.ts), PR #352. Narration is derived only from the tool name, arguments and result,
// so the same call reads the same from Codex dynamic tools, Claude Code and ACP MCP calls.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';

const narrationUrl = new URL('../src/lib/agentNarration.ts', import.meta.url).href;
// the renderer's bundler resolves extensionless imports; Node needs the file's own extension
registerHooks({
  resolve(s, c, next) {
    if (c.parentURL === narrationUrl && s === './toolOutput')
      return { shortCircuit: true, url: new URL('../src/lib/toolOutput.ts', import.meta.url).href };
    return next(s, c);
  },
});
const { controlTool, controlStep, controlThumbnail, hostOf, recoveredFailures, ownDesktopTool } = await import(narrationUrl);
const { withAgentTabs, agentTabFor, agentChatsUsing, accessLabel, agentTabBadge, viewChats, inView, frontTab, paneLayer } = await import(
  '../src/lib/agentTabs.ts'
);

const PNG = 'iVBORw0KGgo=';
/** A finished call as each harness reports it. */
const mcp = (tool: string, args: any = {}, text = '', extra: any[] = []) => ({
  type: 'mcpToolCall',
  server: 'sage',
  tool,
  arguments: args,
  status: 'completed',
  result: { content: [...(text ? [{ type: 'text', text }] : []), ...extra] },
});
const dyn = (tool: string, args: any = {}, text = '') => ({
  type: 'dynamicToolCall',
  tool,
  arguments: args,
  status: 'completed',
  contentItems: text ? [{ type: 'inputText', text }] : [],
});
const done = (tool: string, args: any = {}, text = '') => controlStep(mcp(tool, args, text))?.done;
const doing = (tool: string, args: any = {}, text = '') => controlStep(mcp(tool, args, text))?.doing;

test("controlTool reads the browser/desktop tool behind any harness's naming", () => {
  assert.deepEqual(controlTool('browser_navigate'), { surface: 'browser', name: 'navigate' });
  assert.deepEqual(controlTool('mcp__sage_0123456789ab__browser_navigate'), { surface: 'browser', name: 'navigate' });
  assert.deepEqual(controlTool('mcp__Claude_in_Chrome__desktop_left_click'), { surface: 'desktop', name: 'left_click' });
  assert.deepEqual(controlTool('sage.desktop_type'), { surface: 'desktop', name: 'type' });
  assert.deepEqual(controlTool('server/browser_find'), { surface: 'browser', name: 'find' });
  assert.deepEqual(controlTool('acp:sage_browser_click'), { surface: 'browser', name: 'click' });
  for (const t of ['sage_debug_echo', 'computer_click', 'browser_', 'Browser_navigate', '', null, 42, undefined, 'mcp__x__'])
    assert.equal(controlTool(t), null, String(t));
});

test('hostOf: hosts for URLs and bare addresses; the text itself when it is not one', () => {
  assert.equal(hostOf('https://example.com/a?b'), 'example.com');
  assert.equal(hostOf('example.com/path'), 'example.com');
  assert.equal(hostOf('http://localhost:5173/'), 'localhost:5173');
  assert.equal(hostOf('about:blank'), 'about:blank');
  assert.equal(hostOf('file:///tmp/x.html'), 'file:///tmp/x.html');
  assert.equal(hostOf('http://[bad'), 'http://[bad');
  assert.equal(hostOf(null), '');
  assert.equal(hostOf('not a url '.repeat(10)), `${'not a url '.repeat(6).slice(0, 59)}…`);
});

test('browser navigation, tabs and reading', () => {
  assert.equal(done('browser_navigate', { url: 'https://example.com/x' }), 'Opened example.com');
  assert.equal(doing('browser_navigate', { url: 'example.com' }), 'Opening example.com');
  assert.equal(done('browser_navigate', { url: 'back' }), 'Went back');
  assert.equal(doing('browser_navigate', { url: 'forward' }), 'Going forward');
  assert.equal(done('browser_navigate', { url: 'reload' }), 'Reloaded the page');
  // a call without a url (a malformed request) still narrates rather than throwing
  assert.match(done('browser_navigate', {})!, /^Opened/);
  assert.equal(done('browser_navigate_back'), 'Went back');
  assert.equal(done('browser_tabs_context'), 'Checked the open tabs');
  assert.equal(done('browser_tabs_create', { url: 'https://a.test/' }), 'Opened a.test in a new tab');
  assert.equal(doing('browser_tabs_create'), 'Opening a new tab');
  assert.equal(done('browser_tabs_close'), 'Closed a tab');
  assert.equal(done('browser_tabs_select'), 'Switched tabs');
  assert.equal(done('browser_tabs_mark'), 'Kept a tab open for you');
  assert.equal(done('browser_tabs'), 'Managed tabs');
  assert.equal(done('browser_read_page'), 'Read the page');
  assert.equal(done('browser_snapshot'), 'Read the page');
  assert.equal(done('browser_find', { query: '  sign   in  ' }), 'Looked for “sign in”');
  assert.equal(done('browser_get_page_text'), 'Read the page text');
  assert.equal(done('browser_history_search', { query: 'docs' }), 'Searched your history for “docs”');
  assert.equal(doing('browser_history_search', { query: 'docs' }), 'Searching your history for “docs”');
  assert.equal(done('browser_history_search', {}), 'Looked at your recent history');
  assert.equal(doing('browser_history_search', {}), 'Looking at your recent history');
  assert.equal(done('browser_bookmarks_search', { query: 'docs' }), 'Searched your bookmarks for “docs”');
  assert.equal(doing('browser_bookmarks_search', { query: 'docs' }), 'Searching your bookmarks for “docs”');
  assert.equal(done('browser_bookmarks_search', {}), 'Looked through your bookmarks');
  assert.equal(doing('browser_bookmarks_search', {}), 'Looking through your bookmarks');
  assert.equal(done('browser_close'), 'Closed the browser');
  assert.equal(done('browser_wait_for'), 'Waited for the page');
  assert.equal(done('browser_something_new'), 'Used the browser');
  assert.equal(doing('browser_something_new'), 'Using the browser');
});

test('browser page actions (Playwright-style tools)', () => {
  assert.equal(done('browser_click', { element: 'Submit' }), 'Clicked “Submit”');
  assert.equal(doing('browser_click', {}), 'Clicking the page');
  assert.equal(done('browser_click', { element: 'Row', doubleClick: true }), 'Double-clicked “Row”');
  assert.equal(doing('browser_click', { doubleClick: true }), 'Double-clicking the page');
  assert.equal(done('browser_hover', { element: 'Menu' }), 'Hovered over “Menu”');
  assert.equal(doing('browser_hover'), 'Hovering over the page');
  assert.equal(done('browser_type', { text: 'héllo 👋', element: 'Search' }), 'Typed 7 characters into “Search”');
  assert.equal(done('browser_type', { text: 'a' }), 'Typed 1 character');
  assert.equal(doing('browser_type', { text: 5 }), 'Typing 0 characters');
  assert.equal(done('browser_press_key', { key: 'Enter' }), 'Pressed Enter');
  assert.equal(done('browser_select_option', { element: 'Country' }), 'Chose an option in “Country”');
  assert.equal(doing('browser_select_option'), 'Choosing an option');
  assert.equal(done('browser_form_input'), 'Filled in a form field');
  assert.equal(done('browser_fill_form'), 'Filled in a form field');
  assert.equal(done('browser_take_screenshot'), 'Took a screenshot');
  assert.equal(done('browser_javascript_exec'), 'Ran JavaScript on the page');
  assert.equal(done('browser_evaluate'), 'Ran JavaScript on the page');
  assert.equal(done('browser_read_console_messages'), 'Read the console');
  assert.equal(done('browser_console_messages'), 'Read the console');
  assert.equal(done('browser_read_network_requests'), 'Read network requests');
  assert.equal(done('browser_network_requests'), 'Read network requests');
  assert.equal(done('browser_resize_window', { preset: 'mobile' }), 'Resized the page to mobile size');
  assert.equal(done('browser_resize', { width: 800, height: 600 }), 'Resized the page to 800×600');
  assert.equal(doing('browser_resize', { width: 800 }), 'Resizing the page to a new size');
  assert.equal(done('browser_handle_dialog', { accept: true }), 'Accepted a dialog');
  assert.equal(done('browser_handle_dialog', {}), 'Dismissed a dialog');
  assert.equal(done('browser_file_upload', { paths: ['/a', '/b'] }), 'Uploaded 2 files');
  assert.equal(done('browser_file_upload', {}), 'Uploaded 1 file');
  assert.equal(done('browser_batch', { actions: [{}, {}, {}] }), 'Ran 3 browser actions');
  assert.equal(doing('browser_batch', {}), 'Running 0 browser actions');
});

test("browser computer actions name the clicked element from the host's result", () => {
  const ref = 'Clicked at (10, 20) on ref_12 "Sign \\"in\\""';
  assert.equal(done('browser_computer', { action: 'left_click', ref: 'ref_12' }, ref), 'Clicked “Sign "in"”');
  assert.equal(doing('browser_computer', { action: 'right_click', ref: 'ref_3' }), 'Right-clicking an element');
  assert.equal(done('browser_computer', { action: 'double_click', target: { ref: 'ref_3' } }), 'Double-clicked an element');
  assert.equal(done('browser_computer', { action: 'triple_click' }), 'Triple-clicked the page');
  assert.equal(done('browser_computer', { action: 'middle_click' }), 'Middle-clicked the page');
  // a malformed or empty name falls back to the element
  assert.equal(done('browser_computer', { action: 'left_click', ref: 'ref_1' }, 'on ref_1 ""'), 'Clicked an element');
  assert.equal(done('browser_computer', { action: 'left_click', ref: 'ref_1' }, 'on ref_1 "bad \\x"'), 'Clicked an element');
  assert.equal(done('browser_computer', { action: 'type', text: 'abc' }), 'Typed 3 characters');
  assert.equal(doing('browser_computer', { action: 'type' }), 'Typing 0 characters');
  assert.equal(done('browser_computer', { action: 'key', text: 'cmd+a' }), 'Pressed cmd+a');
  assert.equal(done('browser_computer', { action: 'scroll', scroll_direction: 'up' }), 'Scrolled up');
  assert.equal(doing('browser_computer', { action: 'scroll' }), 'Scrolling down');
  assert.equal(done('browser_computer', { action: 'scroll_to' }), 'Scrolled to an element');
  assert.equal(done('browser_computer', { action: 'hover', ref: 'ref_2' }), 'Hovered over an element');
  assert.equal(done('browser_computer', { action: 'left_click_drag' }), 'Dragged on the page');
  assert.equal(done('browser_computer', { action: 'screenshot' }), 'Took a screenshot');
  assert.equal(done('browser_computer', { action: 'zoom' }), 'Zoomed in on the page');
  assert.equal(done('browser_computer', { action: 'wait', duration: 2.25 }), 'Waited 2.3 seconds');
  assert.equal(doing('browser_computer', { action: 'wait' }), 'Waiting 1 second');
  assert.equal(done('browser_computer', { action: 'wait', duration: -3 }), 'Waited 0 seconds');
  assert.equal(done('browser_computer', { action: 'wait', duration: 'soon' }), 'Waited 0 seconds');
  assert.equal(done('browser_computer', {}), 'Used the browser');
});

test('desktop actions name the app the action record reports', () => {
  const rec = 'Done.\n{"action":"left_click","app":"Notes"}';
  assert.equal(done('desktop_left_click', {}, rec), 'Clicked in Notes');
  assert.equal(doing('desktop_double_click'), 'Double-clicking on the screen');
  // records that are not JSON, or name no app, are skipped
  assert.equal(done('desktop_right_click', {}, '{not json\n{"action":"x"}\n{"app":""}'), 'Right-clicked on the screen');
  assert.equal(done('desktop_type', { text: 'hi' }, rec), 'Typed 2 characters in Notes');
  assert.equal(doing('desktop_type', {}), 'Typing 0 characters');
  assert.equal(done('desktop_key', { text: 'cmd+s' }, rec), 'Pressed ⌘S in Notes');
  assert.equal(done('desktop_scroll', { scroll_direction: 'left' }), 'Scrolled left');
  assert.equal(doing('desktop_scroll', {}, rec), 'Scrolling down in Notes');
  assert.equal(done('desktop_left_click_drag', {}, rec), 'Dragged in Notes');
  assert.equal(doing('desktop_left_click_drag'), 'Dragging on the screen');
  assert.equal(done('desktop_left_mouse_down', {}, rec), 'Pressed the mouse button in Notes');
  assert.equal(doing('desktop_left_mouse_down'), 'Pressing the mouse button');
  assert.equal(done('desktop_left_mouse_up', {}), 'Let go of the mouse button');
  assert.equal(doing('desktop_left_mouse_up'), 'Letting go of the mouse button');
  assert.equal(done('desktop_request_access', { apps: ['Notes', 'Safari'] }), 'Asked to use Notes, Safari');
  assert.equal(done('desktop_request_access', { apps: ['A', 'B', 'C', 'D', 'E'] }), 'Asked to use A, B, C and 2 more');
  assert.equal(doing('desktop_request_access', { apps: ['', null] }), 'Asking to use apps');
  assert.equal(done('desktop_request_access', {}), 'Asked to use apps');
  assert.equal(done('desktop_list_granted_applications'), 'Checked which apps it may use');
  assert.equal(done('desktop_open_application', { app: 'Calendar' }), 'Opened Calendar');
  assert.equal(doing('desktop_open_application'), 'Opening an app');
  assert.equal(done('desktop_switch_display', {}), 'Listed the displays');
  assert.equal(done('desktop_switch_display', { display: '' }), 'Listed the displays');
  assert.equal(done('desktop_switch_display', { display: 'Built-in' }), 'Switched displays');
  assert.equal(done('desktop_read_clipboard'), 'Read the clipboard');
  assert.equal(done('desktop_write_clipboard'), 'Copied text to the clipboard');
  assert.equal(done('desktop_screenshot'), 'Captured screen');
  assert.equal(done('desktop_zoom'), 'Zoomed in on the screen');
  assert.equal(done('desktop_mouse_move'), 'Moved the pointer');
  assert.equal(done('desktop_hold_key', { text: 'shift', duration: 1 }), 'Held shift for 1 second');
  assert.equal(done('desktop_wait', { duration: 3 }), 'Waited 3 seconds');
  assert.equal(done('desktop_cursor_position'), 'Checked the pointer position');
  assert.equal(done('desktop_batch', { actions: [{}] }), 'Ran 1 desktop action');
  assert.equal(doing('desktop_batch'), 'Running 0 desktop actions');
  assert.equal(done('desktop_teach'), 'Used your computer');
  assert.equal(doing('desktop_teach'), 'Using your computer');
});

test('controlStep: the same call reads the same from every harness; other tools are not narrated', () => {
  const codex = controlStep(dyn('browser_navigate', { url: 'https://a.test' }));
  const claude = controlStep(mcp('mcp__sage_0123456789ab__browser_navigate', { url: 'https://a.test' }));
  const acp = controlStep(mcp('sage.browser_navigate', { url: 'https://a.test' }));
  assert.deepEqual(codex, { surface: 'browser', done: 'Opened a.test', doing: 'Opening a.test' });
  assert.deepEqual(claude, codex);
  assert.deepEqual(acp, codex);
  // a Codex dynamic tool's result text names the clicked element too
  assert.equal(controlStep(dyn('browser_computer', { action: 'left_click', ref: 'ref_1' }, 'on ref_1 "OK"'))!.done, 'Clicked “OK”');
  // arguments that are not an object, or missing
  assert.equal(controlStep({ tool: 'desktop_type', arguments: 'oops' })!.done, 'Typed 0 characters');
  assert.equal(controlStep({ tool: 'browser_find' })!.done, 'Looked for “”');
  // a failed call: its error message is the result text
  assert.equal(controlStep({ tool: 'desktop_left_click', error: { message: '{"app":"Finder"}' } })!.done, 'Clicked in Finder');
  assert.equal(controlStep(mcp('sage_debug_echo')), null);
  assert.equal(controlStep(null), null);
  assert.equal(controlStep({}), null);
});

test("controlThumbnail: the last screenshot a call returned, from any harness's image shape", () => {
  const two = mcp('browser_computer', { action: 'screenshot' }, 'shot', [
    { type: 'image', data: PNG, mimeType: 'image/png' },
    { type: 'image', data: 'second', mimeType: 'image/jpeg' },
  ]);
  assert.equal(controlThumbnail(two), 'data:image/jpeg;base64,second');
  assert.equal(
    controlThumbnail({ contentItems: [{ type: 'inputImage', imageUrl: `data:image/png;base64,${PNG}` }] }),
    `data:image/png;base64,${PNG}`,
  );
  assert.equal(controlThumbnail(mcp('desktop_type', { text: 'x' }, 'typed')), null);
  assert.equal(controlThumbnail(null), null);
});

test('recoveredFailures: a failure is recovered only by a later finished success on the same surface', () => {
  const b = (failed: boolean, finished = true) => ({ surface: 'browser' as const, failed, finished });
  const d = (failed: boolean, finished = true) => ({ surface: 'desktop' as const, failed, finished });
  assert.deepEqual(recoveredFailures([]), []);
  // browser fail, then a non-control step, then a browser success: recovered
  assert.deepEqual(recoveredFailures([b(true), null, b(false)]), [true, false, false]);
  // the last failure has nothing after it; a desktop success does not recover a browser failure
  assert.deepEqual(recoveredFailures([b(true), b(false), b(true), d(false)]), [true, false, false, false]);
  // a step still running is no success yet; desktop steps follow the same rule
  assert.deepEqual(recoveredFailures([d(true), d(false, false)]), [false, false]);
  assert.deepEqual(recoveredFailures([d(true), d(true), d(false)]), [true, true, false]);
});

test('request_access: apps the user always allows read as a compact line, the same from every harness', () => {
  const res = (o: any) => JSON.stringify({ granted: [], denied: [], ...o }, null, 1);
  // Codex dynamic tools, ACP and Claude MCP calls: the same result, the same line
  assert.equal(
    done('desktop_request_access', { apps: ['TextEdit'] }, res({ alwaysAllowed: ['TextEdit'] })),
    'Using TextEdit (always allowed)',
  );
  assert.equal(
    controlStep(dyn('desktop_request_access', { apps: ['TextEdit'] }, res({ alwaysAllowed: ['TextEdit'] })))!.doing,
    'Using TextEdit (always allowed)',
  );
  const claude = controlStep({
    type: 'mcpToolCall',
    server: 'mopilot_computer',
    tool: 'request_access',
    arguments: { apps: ['TextEdit'] },
    status: 'completed',
    result: { content: [{ type: 'text', text: res({ alwaysAllowed: ['TextEdit'] }) }] },
  });
  assert.equal(claude!.done, 'Using TextEdit (always allowed)');
  // some apps remembered, the rest asked for on a card
  assert.equal(
    done('desktop_request_access', { apps: ['TextEdit', 'Notes'] }, res({ alwaysAllowed: ['TextEdit'] })),
    'Using TextEdit (always allowed); asked for the rest',
  );
  assert.equal(
    done('desktop_request_access', { apps: ['A', 'B', 'C', 'D'] }, res({ alwaysAllowed: ['A', 'B', 'C', 'D', ''] })),
    'Using A, B, C and 1 more (always allowed)',
  );
  // nothing remembered, an odd field, or a result that is not JSON: the usual line
  assert.equal(done('desktop_request_access', { apps: ['Notes'] }, res({})), 'Asked to use Notes');
  assert.equal(done('desktop_request_access', { apps: ['Notes'] }, res({ alwaysAllowed: 'Notes' })), 'Asked to use Notes');
  assert.equal(done('desktop_request_access', { apps: ['Notes'] }, 'null'), 'Asked to use Notes');
  assert.equal(done('desktop_request_access', { apps: ['Notes'] }, 'Access denied'), 'Asked to use Notes');
});

test('background app tools: what they did in which app, the same from Codex/ACP (desktop_app_*) and Claude (mopilot_computer app_*), with thumbnails', () => {
  const rec = (o: any) => JSON.stringify({ action: 'x', effect: 'confirmed', route: 'ax', ...o });
  const claude = (tool: string, args: any = {}, text = '', extra: any[] = []) =>
    controlStep({
      type: 'mcpToolCall',
      server: 'mopilot_computer',
      tool,
      arguments: args,
      status: 'completed',
      result: { content: [...(text ? [{ type: 'text', text }] : []), ...extra] },
    });
  // click: the element's name and the app from the action record
  assert.deepEqual(
    controlStep(mcp('desktop_app_click', { app: 'com.apple.TextEdit', element_index: 3 }, rec({ app: 'TextEdit', label: 'Save' }))),
    { surface: 'desktop', done: 'Clicked “Save” in TextEdit', doing: 'Clicking “Save” in TextEdit', app: 'TextEdit' },
  );
  assert.equal(
    claude('app_click', { app: 'com.apple.TextEdit' }, rec({ app: 'TextEdit', label: 'Save' }))!.done,
    'Clicked “Save” in TextEdit',
  );
  assert.equal(controlStep(mcp('mcp__mopilot_computer__app_click', { app: 'TextEdit', count: 2 }))!.done, 'Double-clicked in TextEdit');
  assert.equal(done('desktop_app_click', { count: 3 }), 'Triple-clicked');
  // the app from a refusal's record, the screenshot header, the bundle id, or not at all
  assert.equal(
    done('desktop_app_type', { app: 'com.apple.Notes', text: 'x'.repeat(24) }, `unsupported(not_text): …\n${rec({ app: 'Notes' })}`),
    'Typed 24 characters in Notes',
  );
  assert.equal(doing('desktop_app_type', { app: 'Notes' }), 'Typing 0 characters in Notes');
  assert.equal(done('desktop_app_type', { app: 'com.apple.Notes', text: 'hi' }), 'Typed 2 characters in Notes');
  assert.equal(done('desktop_app_type', { app: '  ', text: 'hi' }), 'Typed 2 characters');
  const shot = mcp(
    'desktop_app_screenshot',
    { app: 'com.apple.TextEdit' },
    'Window 5 "Doc: draft" of TextEdit: coordinate frame 1000x800 pixels.',
    [{ type: 'image', data: PNG, mimeType: 'image/jpeg' }],
  );
  assert.deepEqual([controlStep(shot)!.done, controlStep(shot)!.app], ['Captured screen in TextEdit', 'TextEdit']);
  assert.equal(controlThumbnail(shot), `data:image/jpeg;base64,${PNG}`);
  assert.equal(done('desktop_app_screenshot'), 'Captured screen');
  assert.equal(done('desktop_app_zoom', { app: 'Preview' }), 'Zoomed in on Preview');
  assert.equal(done('desktop_app_zoom'), 'Zoomed in on an app');
  // menus: a path pressed, a menu listed, the bar
  assert.equal(
    claude('app_menu', { app: 'com.apple.Preview', path: ['File', 'Export'] }, rec({ app: 'Preview' }))!.done,
    'Chose File › Export in Preview',
  );
  assert.equal(doing('desktop_app_menu', { app: 'Preview', path: ['File', 'Export…'] }), 'Choosing File › Export… in Preview');
  assert.equal(done('desktop_app_menu', { app: 'Preview', list: ['Format', 'Font'] }), 'Checked the Format › Font menu in Preview');
  assert.equal(doing('desktop_app_menu', { app: 'Preview', list: 'File' }), 'Checking the File menu in Preview');
  assert.equal(done('desktop_app_menu', { app: 'Preview', list: null, path: [] }), 'Checked the menus in Preview');
  assert.equal(doing('desktop_app_menu', { app: 'Preview' }), 'Checking the menus in Preview');
  // the rest
  assert.equal(done('desktop_app_key', { app: 'Notes', combo: 'return' }), 'Pressed Return in Notes');
  assert.equal(doing('desktop_app_key', { app: 'Notes', combo: 'tab' }), 'Pressing Tab in Notes');
  assert.equal(done('desktop_app_scroll', { app: 'Notes', dy: -3 }), 'Scrolled up in Notes');
  assert.equal(doing('desktop_app_scroll', { app: 'Notes', dy: 3 }), 'Scrolling down in Notes');
  assert.equal(done('desktop_app_drag', { app: 'Notes' }), 'Dragged in Notes');
  assert.equal(doing('desktop_app_drag', { app: 'Notes' }), 'Dragging in Notes');
  assert.equal(done('desktop_app_list_windows', { app: 'Notes' }), 'Checked the windows in Notes');
  assert.equal(doing('desktop_app_list_windows'), 'Checking the windows');
  assert.equal(done('desktop_app_ax_find', { app: 'Notes', title_contains: 'Save' }), 'Looked for “Save” in Notes');
  assert.equal(doing('desktop_app_ax_find', { app: 'Notes', title_contains: ' ' }), 'Looking for an element in Notes');
  assert.equal(done('desktop_app_focus', { app: 'Notes' }), 'Moved the focus in Notes');
  assert.equal(doing('desktop_app_focus', { app: 'Notes' }), 'Moving the focus in Notes');
  assert.equal(done('desktop_app_bring_to_current_space', { app: 'Notes' }), 'Brought Notes to this space');
  assert.equal(doing('desktop_app_bring_to_current_space'), 'Bringing an app to this space');
  assert.equal(done('desktop_app_batch', { app: 'Notes', actions: [{}, {}] }), 'Ran 2 actions in Notes');
  assert.equal(doing('desktop_app_batch', { app: 'Notes' }), 'Running 0 actions in Notes');
  assert.equal(done('desktop_app_release', { app: 'Notes' }), 'Let go of Notes');
  assert.equal(doing('desktop_app_release'), 'Letting go of the apps');
  assert.equal(done('desktop_app_whatever', { app: 'Notes' }), 'Used Notes');
  assert.equal(doing('desktop_app_whatever'), 'Using an app');
  // mopilot_computer's display-scope short names read as the desktop_* tools do
  assert.equal(claude('left_click', {}, rec({ app: 'Finder' }))!.done, 'Clicked in Finder');
  assert.equal(claude('computer_batch', { actions: [{}] })!.done, 'Ran 1 desktop action');
});

test('ownDesktopTool: MoPilot desktop tools by their short name under any harness, nothing for browser, vendor or empty calls', () => {
  assert.deepEqual(ownDesktopTool({ tool: 'desktop_app_key' }), { name: 'app_key' });
  assert.deepEqual(ownDesktopTool({ tool: 'mcp__mopilot_computer__app_key' }), { name: 'app_key' });
  assert.deepEqual(ownDesktopTool({ tool: 'key', server: 'mopilot_computer' }), { name: 'key' });
  assert.equal(ownDesktopTool({ tool: 'browser_navigate' }), null);
  assert.equal(ownDesktopTool({ tool: 'mcp__other__app_key' }), null);
  assert.equal(ownDesktopTool({}), null);
  assert.equal(ownDesktopTool(null), null);
});

/* ---------- agentTabs ---------- */

const view = (patch: any = {}) => ({
  tabId: 'tab_1',
  tabKey: 'tab_1',
  kind: 'tab',
  active: true,
  created: false,
  mark: null,
  takenOver: false,
  origin: 'https://a.test',
  access: 'write',
  ...patch,
});

test("withAgentTabs replaces one chat's tabs and drops a chat that has none left", () => {
  const start = { a: [view()] };
  const added = withAgentTabs(start, 'b', [view({ tabKey: null })]);
  assert.deepEqual(Object.keys(added), ['a', 'b']);
  assert.notEqual(added, start);
  const dropped = withAgentTabs(added, 'a', []);
  assert.deepEqual(Object.keys(dropped), ['b']);
  // nothing to drop: the same map, so the store does not re-render
  assert.equal(withAgentTabs(dropped, 'zzz', []), dropped);
});

test("agentTabFor finds a chat's original tab (null key) or a browser_* tab", () => {
  const map = { chat: [view({ tabKey: null, tabId: 'orig' }), view({ tabKey: 'tab_2', tabId: 'tab_2' })] };
  assert.equal(agentTabFor(map, 'chat', null)!.tabId, 'orig');
  assert.equal(agentTabFor(map, 'chat', undefined)!.tabId, 'orig');
  assert.equal(agentTabFor(map, 'chat', '')!.tabId, 'orig');
  assert.equal(agentTabFor(map, 'chat', 'tab_2')!.tabId, 'tab_2');
  assert.equal(agentTabFor(map, 'chat', 'tab_9'), null);
  assert.equal(agentTabFor(map, 'other', null), null);
  assert.equal(agentTabFor(undefined, 'chat', null), null);
  assert.equal(agentTabFor(map, undefined, null), null);
});

test('agentChatsUsing: chats whose agents actively drive a pane tab, not taken over, once each', () => {
  const map = {
    a: [view({ tabKey: null }), view({ tabKey: 'tab_2' })],
    b: [view({ tabKey: null, takenOver: true })],
    c: [view({ tabKey: null, active: false })],
  };
  const tabs = [
    { kind: 'browser', agentChat: 'a' },
    { kind: 'browser', agentChat: 'a', agentTab: 'tab_2' },
    { kind: 'browser', agentChat: 'b' },
    { kind: 'browser', agentChat: 'c' },
    { kind: 'browser', agentChat: 'gone' },
    { kind: 'browser' },
    { kind: 'terminal', agentChat: 'a' },
  ];
  assert.deepEqual(agentChatsUsing(tabs, map), ['a']);
  assert.deepEqual(agentChatsUsing(tabs, undefined), []);
});

test('accessLabel and agentTabBadge say what the user sees', () => {
  assert.equal(accessLabel('full')!.label, 'Full access');
  assert.equal(accessLabel('write')!.label, 'Can read and act');
  assert.equal(accessLabel('read')!.label, 'Read only');
  assert.equal(accessLabel('denied')!.label, 'Not allowed');
  assert.match(accessLabel('ask')!.detail, /asks you before/);
  assert.equal(accessLabel(null), null);
  assert.equal(agentTabBadge(null), null);
  assert.equal(agentTabBadge(view({ mark: 'handoff', created: true })), 'Opened by the agent for you to continue');
  assert.equal(agentTabBadge(view({ mark: 'deliverable' })), 'Opened by the agent to show you a result');
  assert.equal(agentTabBadge(view({ result: true })), 'Where the agent finished (stays open)');
  assert.equal(agentTabBadge(view({ created: true })), 'Opened by the agent (closes when its turn ends)');
  assert.equal(agentTabBadge(view()), null);
});

/* ---------- a chat's view of the pane ---------- */

test('viewChats: the chat on screen and the side chats open in its pane', () => {
  const tabs = [
    { id: 's1', kind: 'chat', threadId: 'side' },
    { id: 's2', kind: 'chat' },
    { id: 'b', kind: 'browser', threadId: 'x' },
  ];
  assert.deepEqual([...viewChats('chat', tabs)], ['chat', 'side']);
  assert.deepEqual([...viewChats(null, tabs)], ['side']);
  assert.deepEqual([...viewChats(null, [])], []);
});

test("inView: an agent's browser tab only in its own chat's view (or its switched session's chat); other tabs everywhere", () => {
  const chats = new Set(['a']);
  const chatOf = (id: string) => (id === 'claude:a' ? 'a' : id);
  assert.equal(inView({ kind: 'browser', agentChat: 'a' }, chats, chatOf), true);
  assert.equal(inView({ kind: 'browser', agentChat: 'claude:a' }, chats, chatOf), true);
  assert.equal(inView({ kind: 'browser', agentChat: 'b' }, chats, chatOf), false);
  // a chat's Background tasks tab: its chat's view only (or that chat's switched session), never home or another chat
  assert.equal(inView({ kind: 'tasks', threadId: 'a' }, chats, chatOf), true);
  assert.equal(inView({ kind: 'tasks', threadId: 'claude:a' }, chats, chatOf), true);
  assert.equal(inView({ kind: 'tasks', threadId: 'b' }, chats, chatOf), false);
  assert.equal(inView({ kind: 'tasks' }, chats, chatOf), false);
  assert.equal(inView({ kind: 'tasks', threadId: 'a' }, new Set(), chatOf), false);
  assert.equal(inView({ kind: 'browser', agentChat: 'b' }, new Set(), chatOf), false);
  assert.equal(inView({ kind: 'browser' }, chats, chatOf), true);
  assert.equal(inView({ kind: 'terminal', agentChat: 'b' }, chats, chatOf), true);
});

test('frontTab: the active tab when it is in view, else the last tab in view, else none', () => {
  const id = (x: string) => x;
  const tabs = [
    { id: 'mine', kind: 'browser', agentChat: 'a' },
    { id: 'user', kind: 'browser' },
    { id: 'theirs', kind: 'browser', agentChat: 'b' },
  ];
  assert.equal(frontTab(tabs, 'mine', new Set(['a']), id), 'mine');
  assert.equal(frontTab(tabs, 'theirs', new Set(['a']), id), 'user');
  assert.equal(frontTab(tabs, 'theirs', new Set(['b']), id), 'theirs');
  assert.equal(frontTab([tabs[2]], 'theirs', new Set(['a']), id), '');
});

test('paneLayer: the front tab in front; a browser tab an agent drives (not taken over) painted behind; the rest not laid out', () => {
  const map = { a: [view({ tabKey: null }), view({ tabKey: 'tab_2', active: false }), view({ tabKey: 'tab_3', takenOver: true })] };
  assert.equal(paneLayer({ id: 'x', kind: 'changes' }, 'x', map), 'front');
  assert.equal(paneLayer({ id: 'x', kind: 'changes' }, 'y', map), 'none');
  assert.equal(paneLayer({ id: 'x', kind: 'browser' }, 'y', map), 'none');
  assert.equal(paneLayer({ id: 'x', kind: 'browser', agentChat: 'a' }, 'y', map), 'back');
  assert.equal(paneLayer({ id: 'x', kind: 'browser', agentChat: 'a', agentTab: 'tab_2' }, 'y', map), 'none');
  assert.equal(paneLayer({ id: 'x', kind: 'browser', agentChat: 'a', agentTab: 'tab_3' }, 'y', map), 'none');
  assert.equal(paneLayer({ id: 'x', kind: 'browser', agentChat: 'gone' }, 'y', map), 'none');
  assert.equal(paneLayer({ id: 'x', kind: 'browser', agentChat: 'a' }, 'y', undefined), 'none');
});

test('inView: a tab the user opened (ownerChat) shows only in its own chat view, or its switched session', () => {
  const chats = new Set(['a']);
  const chatOf = (id: string) => (id === 'claude:a' ? 'a' : id);
  assert.equal(inView({ kind: 'terminal', ownerChat: 'a' }, chats, chatOf), true);
  assert.equal(inView({ kind: 'browser', ownerChat: 'claude:a' }, chats, chatOf), true);
  assert.equal(inView({ kind: 'file', ownerChat: 'b' }, chats, chatOf), false);
  assert.equal(inView({ kind: 'browser', ownerChat: 'a' }, new Set(), chatOf), false);
});
