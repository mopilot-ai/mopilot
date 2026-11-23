// Action memory's steps (#3571, G4; electron/capabilities/routines/routineSteps.cjs): which browser calls become steps
// and how (anchors instead of refs, the page they ran on), typed values as parameters (also inside a later URL), a
// step's arguments filled in for a run, and the line each step reads as.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const S = createRequire(import.meta.url)('../electron/capabilities/routines/routineSteps.cjs');

const BUTTON = { steps: [{ k: 'role', role: 'button', name: { s: 'Search', exact: true } }], weak: false, secret: false };
const BOX = { steps: [{ k: 'role', role: 'searchbox', name: { s: 'Search terms', exact: true } }], weak: false, secret: false };
const URL = 'https://shop.test/products/12345/reviews';
const PAGE = { origin: 'https://shop.test', path: '/products/*/reviews' };

test('pagePattern: the origin and the path with id-like segments as *; not for non-web pages', () => {
  assert.deepEqual(S.pagePattern(URL), PAGE);
  assert.deepEqual(S.pagePattern('https://a.test/o/0f3a9c2b-77aa-4c1e-9bd0-1234abcd/x?q=1'), { origin: 'https://a.test', path: '/o/*/x' });
  assert.equal(S.pagePattern('about:blank'), null);
  assert.equal(S.pagePattern('not a url'), null);
});

test('pageMatches: same origin and path but for * segments; no pattern matches anything', () => {
  assert.equal(S.pageMatches(PAGE, 'https://shop.test/products/999/reviews'), true);
  assert.equal(S.pageMatches(PAGE, 'https://shop.test/products/999'), false);
  assert.equal(S.pageMatches(PAGE, 'https://shop.test/products/999/answers'), false);
  assert.equal(S.pageMatches(PAGE, 'https://evil.test/products/999/reviews'), false);
  assert.equal(S.pageMatches(PAGE, 'about:blank'), false);
  assert.equal(S.pageMatches(null, 'anything'), true);
});

test('targetKey and callsOf: a ref or a point; a batch is its actions', () => {
  assert.equal(S.targetKey({ ref: 'ref_3' }), 'ref:ref_3');
  assert.equal(S.targetKey({ coordinate: [10, 20] }), 'at:10,20');
  assert.equal(S.targetKey({ coordinate: [10] }), null);
  assert.equal(S.targetKey(undefined), null);
  assert.deepEqual(S.callsOf('browser_navigate', undefined), [{ tool: 'browser_navigate', args: {} }]);
  assert.deepEqual(
    S.callsOf('browser_batch', { actions: [{ name: 'computer', input: { action: 'key' } }, { name: 'browser_navigate' }] }),
    [
      { tool: 'browser_computer', args: { action: 'key' } },
      { tool: 'browser_navigate', args: {} },
    ],
  );
  assert.deepEqual(S.callsOf('browser_batch', {}), []);
});

test('stepsOfCall: actions keep anchors and their page, never refs or tab ids; reads and looks are left out', () => {
  const anchors = new Map<string, any>([
    ['ref:ref_1', BUTTON],
    ['at:5,6', BOX],
  ]);
  assert.deepEqual(S.stepsOfCall('browser_computer', { action: 'left_click', ref: 'ref_1', tabId: '2' }, anchors, URL), [
    { tool: 'browser_computer', args: { action: 'left_click' }, target: { steps: BUTTON.steps }, page: PAGE },
  ]);
  assert.deepEqual(S.stepsOfCall('browser_computer', { action: 'double_click', coordinate: [5, 6] }, anchors, null), [
    { tool: 'browser_computer', args: { action: 'double_click' }, target: { steps: BOX.steps } },
  ]);
  // a scroll at a point is anchored; a plain scroll is not an element step
  assert.ok(S.stepsOfCall('browser_computer', { action: 'scroll', coordinate: [5, 6], scroll_direction: 'down' }, anchors, null)[0].target);
  assert.equal(S.stepsOfCall('browser_computer', { action: 'scroll', scroll_direction: 'down' }, anchors, null)[0].target, undefined);
  // weak anchors say so; a target with no anchor is kept with none (a replay hands off there)
  const weak = new Map([['ref:ref_9', { steps: BUTTON.steps, weak: true }]]);
  assert.deepEqual(S.stepsOfCall('browser_computer', { action: 'hover', ref: 'ref_9' }, weak, null)[0].target, {
    steps: BUTTON.steps,
    weak: true,
  });
  assert.equal(S.stepsOfCall('browser_computer', { action: 'hover', ref: 'ref_404' }, anchors, null)[0].target, null);
  assert.equal(
    S.stepsOfCall('browser_computer', { action: 'hover', ref: 'ref_5' }, new Map([['ref:ref_5', { frame: true }]]), null)[0].target,
    null,
  );
  // typing and keys go to the focus
  assert.deepEqual(S.stepsOfCall('browser_computer', { action: 'type', text: 'hi' }, anchors, URL), [
    { tool: 'browser_computer', args: { action: 'type', text: 'hi' }, page: PAGE },
  ]);
  // waits are capped; looks and reads are left out
  assert.deepEqual(S.stepsOfCall('browser_computer', { action: 'wait', duration: 30 }, anchors, null)[0].args, {
    action: 'wait',
    duration: 5,
  });
  assert.deepEqual(S.stepsOfCall('browser_computer', { action: 'wait' }, anchors, null)[0].args, { action: 'wait', duration: 1 });
  assert.deepEqual(S.stepsOfCall('browser_computer', { action: 'screenshot' }, anchors, null), []);
  assert.deepEqual(S.stepsOfCall('browser_read_page', { filter: 'interactive' }, anchors, null), []);
  assert.deepEqual(S.stepsOfCall('browser_tabs_close', { tabId: '1' }, anchors, null), []);
  // drags, uploads, tab switches and hand-offs can't be replayed: kept as such, so a replay hands off there
  assert.equal(S.stepsOfCall('browser_computer', { action: 'left_click_drag', coordinate: [1, 2] }, anchors, null)[0].unsupported, true);
  for (const tool of ['browser_file_upload', 'browser_tabs_select', 'browser_request_signin', 'browser_preview_start'])
    assert.deepEqual(S.stepsOfCall(tool, { tabId: '1' }, anchors, null), [{ tool, args: {}, unsupported: true }]);
});

test('stepsOfCall: verbatim tools keep their arguments; a navigation has no page; a batch drops the page after it opens one', () => {
  assert.deepEqual(S.stepsOfCall('browser_navigate', { url: 'https://shop.test/', tabId: '1' }, new Map(), URL), [
    { tool: 'browser_navigate', args: { url: 'https://shop.test/' } },
  ]);
  assert.deepEqual(S.stepsOfCall('browser_handle_dialog', { accept: true }, new Map(), URL), [
    { tool: 'browser_handle_dialog', args: { accept: true }, page: PAGE },
  ]);
  const steps = S.stepsOfCall(
    'browser_batch',
    {
      actions: [
        { name: 'computer', input: { action: 'key', text: 'Enter' } },
        { name: 'navigate', input: { url: 'https://shop.test/cart' } },
        { name: 'computer', input: { action: 'left_click', ref: 'ref_1' } },
        { name: 'read_page', input: { filter: 'interactive' } },
      ],
    },
    new Map([['ref:ref_1', BUTTON]]),
    URL,
  );
  assert.deepEqual(steps, [
    { tool: 'browser_computer', args: { action: 'key', text: 'Enter' }, page: PAGE },
    { tool: 'browser_navigate', args: { url: 'https://shop.test/cart' } },
    { tool: 'browser_computer', args: { action: 'left_click' }, target: { steps: BUTTON.steps } },
  ]);
});

test('stepsOfCall: a value filled into a password field is never kept', () => {
  const secret = new Map([['ref:ref_2', { steps: BOX.steps, secret: true }]]);
  assert.deepEqual(S.stepsOfCall('browser_form_input', { ref: 'ref_2', value: 'hunter2' }, secret, null), [
    { tool: 'browser_form_input', args: {}, target: { steps: BOX.steps }, secret: true },
  ]);
  assert.deepEqual(S.stepsOfCall('browser_form_input', { ref: 'ref_2', value: 'ok' }, new Map([['ref:ref_2', BOX]]), null)[0].args, {
    value: 'ok',
  });
});

test('parameterize: each typed value becomes a parameter named after its field, in later URLs too; repeats share one', () => {
  const recorded = [
    { tool: 'browser_navigate', args: { url: 'https://shop.test/' } },
    { tool: 'browser_computer', args: { action: 'left_click' }, target: { steps: BOX.steps } },
    { tool: 'browser_computer', args: { action: 'type', text: 'blue mug' }, target: { steps: BOX.steps } },
    { tool: 'browser_form_input', args: { value: 'blue mug' }, target: { steps: BOX.steps } },
    { tool: 'browser_form_input', args: { value: 'Alex' }, target: { steps: [{ k: 'text', m: { s: 'Your name' } }] } },
    { tool: 'browser_form_input', args: { value: '' }, target: { steps: BOX.steps } },
    { tool: 'browser_form_input', args: { value: true }, target: { steps: BOX.steps } },
    { tool: 'browser_navigate', args: { url: 'https://shop.test/s?q=blue+mug&b=blue%20mug' } },
    { tool: 'browser_tabs_create', args: { url: 'https://shop.test/x' } },
    { tool: 'browser_computer', args: { action: 'type', text: 'x' } },
    { tool: 'browser_form_input', args: { value: 'secret' }, secret: true },
  ];
  const { steps, params } = S.parameterize(recorded);
  assert.deepEqual(params, [
    { name: 'search_terms', example: 'blue mug' },
    { name: 'your_name', example: 'Alex' },
    { name: 'text', example: 'x' },
  ]);
  assert.equal(steps[2].args.text, '{{search_terms}}');
  assert.equal(steps[3].args.value, '{{search_terms}}');
  assert.equal(steps[4].args.value, '{{your_name}}');
  assert.equal(steps[5].args.value, '', 'an empty value stays');
  assert.equal(steps[6].args.value, true);
  assert.equal(steps[7].args.url, 'https://shop.test/s?q={{search_terms}}&b={{search_terms}}');
  assert.equal(steps[8], recorded[8], 'a URL without a parameter value is the same step');
  assert.equal(steps[9].args.text, '{{text}}');
  assert.deepEqual(steps[10], recorded[10]);
});

test('parameterize: an update keeps the routine parameter names, and names never collide', () => {
  const { steps, params } = S.parameterize(
    [
      {
        tool: 'browser_computer',
        args: { action: 'type', text: 'more' },
        target: { steps: [{ k: 'role', role: 'textbox', name: { s: 'Query' } }] },
      },
      {
        tool: 'browser_computer',
        args: { action: 'type', text: 'again' },
        target: { steps: [{ k: 'role', role: 'textbox', name: { s: 'Query' } }] },
      },
    ],
    [{ name: 'query', example: 'mugs' }],
  );
  assert.deepEqual(steps[0].args, { action: 'type', text: '{{query_2}}' });
  assert.deepEqual(
    params.map((p: any) => p.name),
    ['query', 'query_2', 'query_3'],
  );
});

test('parameterize: at most MAX_PARAMS values become parameters; the rest stay as typed', () => {
  const recorded = Array.from({ length: S.MAX_PARAMS + 2 }, (_, i) => ({
    tool: 'browser_computer',
    args: { action: 'type', text: `v${i}` },
  }));
  const { steps, params } = S.parameterize(recorded);
  assert.equal(params.length, S.MAX_PARAMS);
  assert.equal(steps.at(-1).args.text, `v${S.MAX_PARAMS + 1}`);
});

test('fillArgs: values given, else the recorded example, URL-encoded inside a URL; an unknown name is reported missing', () => {
  const params = [{ name: 'q', example: 'blue mug' }];
  assert.deepEqual(S.fillArgs({ args: { action: 'type', text: '{{q}}!' } }, params, { q: 'red cup' }), {
    args: { action: 'type', text: 'red cup!' },
    missing: [],
  });
  assert.deepEqual(S.fillArgs({ args: { url: 'https://s.test/?q={{q}}' } }, params, { q: null }).args.url, 'https://s.test/?q=blue%20mug');
  assert.deepEqual(S.fillArgs({ args: { text: '{{nope}}', n: 3 } }, params, {}), { args: { text: '', n: 3 }, missing: ['nope'] });
  assert.deepEqual(S.fillArgs({ args: { text: 'plain' } }, params, {}).args.text, 'plain');
  assert.equal(S.fillArgs({ args: { text: '{{q}}' } }, params, { q: 7 }).args.text, '7');
});

test('describeStep and targetName: one readable line per step', () => {
  assert.equal(
    S.describeStep({ tool: 'browser_computer', args: { action: 'left_click' }, target: { steps: BUTTON.steps } }),
    'left_click "Search"',
  );
  assert.equal(S.describeStep({ tool: 'browser_computer', args: { action: 'left_click' }, target: null }), 'left_click');
  assert.equal(S.describeStep({ tool: 'browser_computer', args: { action: 'type', text: '{{q}}' } }), 'type "{{q}}"');
  assert.equal(S.describeStep({ tool: 'browser_computer', args: { action: 'type' } }), 'type ""');
  assert.equal(S.describeStep({ tool: 'browser_computer', args: { action: 'key', text: 'Enter' } }), 'key Enter');
  assert.equal(S.describeStep({ tool: 'browser_computer', args: { action: 'key' } }), 'key ');
  assert.equal(S.describeStep({ tool: 'browser_form_input', args: {}, target: { steps: BOX.steps } }), 'fill "Search terms"');
  assert.equal(S.describeStep({ tool: 'browser_form_input', args: {}, secret: true }), 'fill a password field');
  assert.equal(S.describeStep({ tool: 'browser_navigate', args: { url: 'https://a.test/' } }), 'navigate https://a.test/');
  assert.equal(S.describeStep({ tool: 'browser_tabs_create', args: {} }), 'tabs_create ');
  assert.equal(S.describeStep({ tool: 'browser_script', args: {} }), 'script');
  assert.equal(
    S.targetName({
      target: {
        steps: [
          { k: 'text', m: { s: 'Hello' } },
          { k: 'nth', i: 1 },
        ],
      },
    }),
    'Hello',
  );
  assert.equal(S.targetName({ target: { steps: [{ k: 'role', role: 'textbox' }] } }), null);
  assert.equal(S.targetName({}), null);
});

test('stepsOfCall: a form fill that named no element keeps no anchor', () => {
  assert.equal(S.stepsOfCall('browser_form_input', { value: 'ok' }, new Map(), null)[0].target, null);
});

test("chrome_* tools record as the browser_* tool each runs, keeping their own name (in step with chromeTools.cjs's TOOLS)", () => {
  const { TOOLS, PREFIX } = createRequire(import.meta.url)('../electron/capabilities/browser/chromeTools.cjs');
  for (const [name, t] of Object.entries<any>(TOOLS)) assert.equal(S.baseOf(`${PREFIX}${name}`), t.via ?? 'browser_batch', name);
  assert.equal(S.baseOf('browser_navigate'), 'browser_navigate');
  assert.equal(S.prefixOf('chrome_computer'), 'chrome_');
  assert.equal(S.prefixOf('browser_computer'), 'browser_');
  const anchors = new Map([['ref:ref_1', BUTTON]]);
  assert.deepEqual(S.stepsOfCall('chrome_computer', { action: 'left_click', ref: 'ref_1', tabId: 41 }, anchors, URL), [
    { tool: 'chrome_computer', args: { action: 'left_click' }, target: { steps: BUTTON.steps }, page: PAGE },
  ]);
  assert.deepEqual(S.stepsOfCall('chrome_read_page', { filter: 'interactive' }, anchors, URL), []);
  assert.equal(S.stepsOfCall('chrome_upload_image', {}, anchors, URL)[0].unsupported, true);
  // a Chrome batch's actions are chrome_* tools
  assert.deepEqual(
    S.stepsOfCall('chrome_browser_batch', { actions: [{ name: 'navigate', input: { url: 'https://a.test/' } }] }, anchors, null),
    [{ tool: 'chrome_navigate', args: { url: 'https://a.test/' } }],
  );
  assert.equal(S.describeStep({ tool: 'chrome_navigate', args: { url: 'https://a.test/' } }), 'navigate https://a.test/');
  const { steps, params } = S.parameterize([
    { tool: 'chrome_computer', args: { action: 'left_click' }, target: { steps: BOX.steps } },
    { tool: 'chrome_computer', args: { action: 'type', text: 'tea' } },
    { tool: 'chrome_navigate', args: { url: 'https://a.test/?q=tea' } },
  ]);
  assert.deepEqual(params, [{ name: 'search_terms', example: 'tea' }]);
  assert.equal(steps[2].args.url, 'https://a.test/?q={{search_terms}}');
});

test('reads a task rests on are steps that yield data; parts count from 1', () => {
  const none = new Map();
  assert.deepEqual(S.stepsOfCall('browser_get_page_text', { tabId: 'tab_1' }, none, URL), [
    { tool: 'browser_get_page_text', args: {}, reads: true, page: S.pagePattern(URL) },
  ]);
  assert.deepEqual(S.stepsOfCall('chrome_read_page', { filter: 'all', tabId: 4 }, none, URL), [
    { tool: 'chrome_read_page', args: { filter: 'all' }, reads: true, page: S.pagePattern(URL) },
  ]);
  // a read with no page known keeps none, and a replay stops at it
  assert.deepEqual(S.stepsOfCall('browser_get_page_text', {}, none, null), [{ tool: 'browser_get_page_text', args: {}, reads: true }]);
  assert.equal(S.yieldsData({ tool: 'browser_get_page_text', args: {}, reads: true }), true);
  assert.equal(S.yieldsData({ tool: 'browser_script', args: {} }), true);
  assert.equal(S.yieldsData({ tool: 'chrome_javascript_tool', args: {} }), true);
  assert.equal(S.yieldsData({ tool: 'browser_navigate', args: {} }), false);
  assert.equal(S.partOf({}), 1);
  assert.equal(S.partOf({ part: 2 }), 2);
  assert.equal(S.partsOf([{}, { part: 3 }, { part: 2 }]), 3);
  assert.equal(S.partsOf([]), 1);
});
