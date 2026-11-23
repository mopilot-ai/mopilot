// Page reads, captures and computer-action mapping cases.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { world, first, endsWithState, code } from './fixture';

export function registerComputerCases() {
  // ---------------------------------------------------------------- reading

  test('browser_read_page defaults to visible elements, depth 15 and 50,000 characters', async () => {
    const w = world();
    const out = await w.call('browser_read_page');
    assert.deepEqual(w.tabs.called('readPage'), [[w.tabs.tab, { filter: 'visible', depth: 15, ref: null, maxChars: 50000 }]]);
    assert.equal(
      first(out),
      'Page t1: A page — https://a.example/page (elements in the viewport; filter "all" includes the rest)\nbutton "OK" [ref_1]',
    );
    endsWithState(out);
  });

  test('browser_read_page with interactive filter, ref_id, clamped limits and truncation', async () => {
    const w = world();
    w.tabs.impl.readPage = async () => ({ lines: ['a', 'b'], truncated: true });
    const out = await w.call('browser_read_page', { filter: 'interactive', depth: 2.6, max_chars: 10, ref_id: 'ref_3' });
    assert.deepEqual(w.tabs.called('readPage')[0][1], { filter: 'interactive', depth: 3, ref: 'ref_3', maxChars: 1000 });
    assert.equal(
      first(out),
      'Page t1: A page — https://a.example/page (interactive elements in the viewport; filter "all" includes the rest)\na\nb\n[Output truncated at the 1,000-character limit. Narrow it with a smaller depth or a ref_id.]',
    );
  });

  test('browser_read_page with filter all, a ref alias, an untitled empty page and an unknown filter', async () => {
    const w = world();
    w.tabs.tab.title = '';
    w.tabs.impl.readPage = async () => ({ lines: [], truncated: false });
    const out = await w.call('browser_read_page', { filter: 'all', ref: 'ref_4', max_chars: 999999 });
    assert.deepEqual(w.tabs.called('readPage')[0][1], { filter: 'all', depth: 15, ref: 'ref_4', maxChars: 50000 });
    assert.equal(first(out), 'Page t1: (untitled) — https://a.example/page\n(nothing to show)');
    await w.call('browser_read_page', { filter: 'bogus' });
    assert.equal(w.tabs.called('readPage')[1][1].filter, 'visible');
  });

  test('browser_find reports no match, one match and several matches', async () => {
    const w = world();
    w.tabs.impl.find = async () => [];
    assert.equal(
      first(await w.call('browser_find', { query: 'sign\nin' })),
      'Nothing in t1 matches "sign in". Try other words, or browser_read_page with filter "all".',
    );
    assert.deepEqual(w.tabs.called('find')[0], [w.tabs.tab, 'sign\nin', 20]);
    w.tabs.impl.find = async () => ['x [ref_1]'];
    assert.equal(first(await w.call('browser_find', { query: 'x' })), '1 match in t1:\nx [ref_1]');
    w.tabs.impl.find = async () => ['x [ref_1]', 'y [ref_2]'];
    const out = await w.call('browser_find', { query: 'x' });
    assert.equal(first(out), '2 matches in t1:\nx [ref_1]\ny [ref_2]');
    endsWithState(out);
  });

  test('browser_get_page_text clamps its limit and notes truncation', async () => {
    const w = world();
    let out = await w.call('browser_get_page_text');
    assert.deepEqual(w.tabs.called('pageText')[0], [w.tabs.tab, 50000]);
    assert.equal(first(out), 'Page t1: A page — https://a.example/page\n\nhello');
    w.tabs.impl.pageText = async () => ({ title: 'T', url: 'https://a.example/', text: 'body', truncated: true });
    out = await w.call('browser_get_page_text', { max_chars: 1e9 });
    assert.equal(w.tabs.called('pageText')[1][1], 200000);
    assert.equal(first(out), 'Page t1: T — https://a.example/\n\nbody\n[Text truncated at 200,000 characters.]');
    await w.call('browser_get_page_text', { max_chars: 5 });
    assert.equal(w.tabs.called('pageText')[2][1], 1000);
  });

  test('browser_get_page_text says when the page is one of several of a list (#3571)', async () => {
    const w = world();
    w.tabs.impl.pageText = async () => ({
      title: 'Orders',
      url: 'https://shop.test/orders',
      text: '17 orders\nPage 1 of 2: 1 2',
      truncated: false,
    });
    const out = await w.call('browser_get_page_text');
    assert.equal(
      first(out),
      'Page t1: Orders — https://shop.test/orders\n\n17 orders\nPage 1 of 2: 1 2\n[This is page 1 of 2 of a list: the rest is on the other page. Open it before counting or totalling.]',
    );
    w.tabs.impl.pageText = async () => ({ title: 'Orders', url: 'https://shop.test/orders?page=2', text: 'Page 2 of 2', truncated: false });
    assert.equal(first(await w.call('browser_get_page_text')).includes('[This is page'), false);
  });

  // ---------------------------------------------------------------- browser_computer

  test('computer wait: duration 0, negative, default with abort, and clamped to 30 seconds', async () => {
    const w = world();
    let out = await w.call('browser_computer', { action: 'wait', duration: 0 });
    assert.equal(first(out), 'Waited 0 seconds. Tab t1 is at https://a.example/page (A page).');
    endsWithState(out);
    assert.equal(w.tabs.called('run').length, 0);
    out = await w.call('browser_computer', { action: 'wait', duration: -5 });
    assert.match(first(out), /^Waited 0 seconds\./);

    for (const [args, said] of [
      [{ action: 'wait' }, 'Waited 1 second.'],
      [{ action: 'wait', duration: 99 }, 'Waited 30 seconds.'],
    ] as const) {
      const ac = new AbortController();
      const started = Date.now();
      const p = w.call('browser_computer', args, { ...w.ctx, signal: ac.signal });
      setTimeout(() => ac.abort(), 5);
      out = await p;
      assert.ok(Date.now() - started < 900, 'the abort ends the wait early');
      assert.match(first(out), new RegExp(`^${said.replace('.', '\\.')} `));
    }
    // a turn already stopped doesn't wait at all
    const stopped = new AbortController();
    stopped.abort();
    const started = Date.now();
    out = await w.call('browser_computer', { action: 'wait', duration: 2 }, { ...w.ctx, signal: stopped.signal });
    assert.ok(Date.now() - started < 500, 'returns at once');
    assert.match(first(out), /^Waited 2 seconds\./);
  });

  test('computer screenshot at full scale reports the frame without a scaling note', async () => {
    const w = world();
    const out = await w.call('browser_computer', { action: 'screenshot' });
    assert.deepEqual(w.tabs.called('capture'), [[w.tabs.tab, { w: 800, h: 600 }, { region: null, scale: undefined }]]);
    assert.deepEqual(
      w.tabs.called('ready').map((c: any) => c[2]),
      [undefined, { input: true }],
    );
    assert.equal(
      out[0].text,
      'Screenshot of t1: image 800x600. Coordinate frame: 800x600 (full viewport, CSS pixels); give coordinates in that frame. Tab t1 is at https://a.example/page (A page).',
    );
    assert.deepEqual(out[1], { type: 'image', data: 'IMG', mimeType: 'image/jpeg' });
    // the image is kept with an id the upload can attach (#1530)
    assert.match(
      out[2].text,
      /^Screenshot ID: ss_[0-9a-f]{8}\. To attach it to a file input, give it in browser_file_upload's screenshots\.$/,
    );
    endsWithState(out);
    assert.equal(out.length, 4);
  });

  test('computer screenshot scaled down notes the multiplier', async () => {
    const w = world();
    w.tabs.impl.capture = async () => ({ width: 400, height: 300, data: 'S' });
    const out = await w.call('browser_computer', { action: 'screenshot', scale: 0.5 });
    assert.equal(w.tabs.called('capture')[0][2].scale, 0.5);
    assert.match(
      out[0].text,
      /image 400x300\. Coordinate frame: 800x600 .*give coordinates in that frame \(image pixel × 2\.000\)\. Tab t1/,
    );
  });

  test('computer zoom notes the region origin, with and without scaling, and needs a region', async () => {
    const w = world();
    w.tabs.impl.capture = async () => ({ rect: { x: 10, y: 20, width: 100, height: 50 }, width: 200, height: 100, data: 'Z' });
    let out = await w.call('browser_computer', { action: 'zoom', region: [10, 20, 110, 70] });
    assert.deepEqual(w.tabs.called('capture')[0][2], { region: [10, 20, 110, 70], scale: undefined });
    assert.match(out[0].text, /^Zoom of region \[10, 20, 110, 70\] of t1: image 200x100\..*\(image pixel × 0\.500 \+ region origin\)\./);

    w.tabs.impl.capture = async () => ({ rect: { x: 0, y: 0, width: 100, height: 50 }, width: 100, height: 50, data: 'Z' });
    out = await w.call('browser_computer', { action: 'zoom', region: [0, 0, 100, 50] });
    assert.match(out[0].text, /give coordinates in that frame \(image pixel \+ region origin\)\. Tab/);

    await assert.rejects(w.call('browser_computer', { action: 'zoom' }), code('bad_args', /zoom needs region/));
    assert.equal(w.tabs.called('capture').length, 2);
  });

  test('computer screenshot on a denied page is refused', async () => {
    const w = world();
    w.grants.denied.set('c1', new Set(['https://z.example']));
    w.tabs.tab.url = 'https://z.example/';
    await assert.rejects(w.call('browser_computer', { action: 'screenshot' }), code('denied'));
    assert.equal(w.tabs.called('capture').length, 0);
  });

  test('computer scroll_to scrolls a ref into view (plain or as a target) and needs one', async () => {
    const w = world();
    let out = await w.call('browser_computer', { action: 'scroll_to', ref: 'ref_5' });
    assert.equal(first(out), 'Scrolled ref_5 into view. Tab t1 is at https://a.example/page (A page).');
    assert.deepEqual(w.tabs.called('scrollTo'), [[w.tabs.tab, 'ref_5']]);
    assert.deepEqual(w.tabs.called('settle'), [[w.tabs.tab, { grace: 100 }]]);
    out = await w.call('browser_computer', { action: 'scroll_to', target: { type: 'ref', ref: 'ref_6' } });
    assert.deepEqual(w.tabs.called('scrollTo')[1], [w.tabs.tab, 'ref_6']);
    await assert.rejects(w.call('browser_computer', { action: 'scroll_to' }), code('bad_args', /scroll_to needs a ref/));
  });

  test('computer hover moves the pointer, noting a dialog that opened', async () => {
    const w = world();
    let out = await w.call('browser_computer', { action: 'hover', coordinate: [5.4, 6.6] });
    assert.equal(first(out), 'Moved the pointer to (5, 7). Tab t1 is at https://a.example/page (A page).');
    assert.deepEqual(w.tabs.called('hover'), [[w.tabs.tab, { x: 5.4, y: 6.6 }]]);
    assert.deepEqual(w.tabs.called('settle'), [[w.tabs.tab, { grace: 100 }]]);
    w.tabs.impl.hover = async () => 'dialog';
    out = await w.call('browser_computer', { action: 'hover', ref: 'ref_1' });
    assert.equal(
      first(out),
      'Moved the pointer to (10, 21). A dialog or file chooser opened; see browser_state. Tab t1 is at https://a.example/page (A page).',
    );
  });

  test('computer scroll defaults to down by 3 at the center, or scrolls at a point or ref', async () => {
    const w = world();
    let out = await w.call('browser_computer', { action: 'scroll' });
    assert.equal(first(out), 'Scrolled down at (400, 300). Tab t1 is at https://a.example/page (A page).');
    assert.deepEqual(w.tabs.called('scroll'), [[w.tabs.tab, { x: 400, y: 300 }, 'down', 3]]);
    assert.equal(w.tabs.called('point').length, 0);
    assert.deepEqual(w.tabs.called('settle'), [[w.tabs.tab, { grace: 200 }]]);

    out = await w.call('browser_computer', { action: 'scroll', coordinate: [1, 2], scroll_direction: 'up', scroll_amount: 5 });
    assert.equal(first(out), 'Scrolled up at (1, 2). Tab t1 is at https://a.example/page (A page).');
    assert.deepEqual(w.tabs.called('scroll')[1], [w.tabs.tab, { x: 1, y: 2 }, 'up', 5]);

    await w.call('browser_computer', { action: 'scroll', ref: 'ref_1' });
    assert.deepEqual(w.tabs.called('point')[1][2], { coordinate: undefined, ref: 'ref_1' });
  });

  test('computer clicks map to button and click count, with modifiers', async () => {
    const w = world();
    const cases: [string, string, number, string][] = [
      ['left_click', 'left', 1, 'left click'],
      ['right_click', 'right', 1, 'right click'],
      ['middle_click', 'middle', 1, 'middle click'],
      ['double_click', 'left', 2, 'double click'],
      ['triple_click', 'left', 3, 'triple click'],
    ];
    for (const [action, button, clickCount, said] of cases) {
      const out = await w.call('browser_computer', { action, coordinate: [1, 2] });
      assert.equal(first(out), `${said} at (1, 2). Tab t1 is at https://a.example/page (A page).`);
      assert.deepEqual(w.tabs.called('click').at(-1), [w.tabs.tab, { x: 1, y: 2 }, { button, clickCount, modifiers: 0, holdMs: 0 }]);
      endsWithState(out);
    }
    assert.equal(w.tabs.called('settle').length, 5);
    await w.call('browser_computer', { action: 'left_click', coordinate: [1, 2], modifiers: 'ctrl+shift' });
    assert.equal(w.tabs.called('click').at(-1)[2].modifiers, 10);
    await assert.rejects(
      w.call('browser_computer', { action: 'left_click', coordinate: [1, 2], modifiers: 'hyper' }),
      code('bad_args', /Unknown modifier: hyper/),
    );
  });

  test('computer click on a ref names the element; a dialog skips settling', async () => {
    const w = world();
    let out = await w.call('browser_computer', { action: 'left_click', ref: 'ref_1' });
    assert.equal(first(out), 'left click at (10, 21) on ref_1 "Submit". Tab t1 is at https://a.example/page (A page).');
    w.tabs.impl.point = async () => ({ x: 1, y: 1 });
    w.tabs.impl.click = async () => 'dialog';
    out = await w.call('browser_computer', { action: 'left_click', ref: 'ref_2' });
    assert.equal(
      first(out),
      'left click at (1, 1) on ref_2. A dialog or file chooser opened; see browser_state. Tab t1 is at https://a.example/page (A page).',
    );
    assert.equal(w.tabs.called('settle').length, 1);
  });

  test('computer targets: {target:{type:"ref"}}, {target:{ref}}, {target:{x,y}} and plain args', async () => {
    const w = world();
    const pointArg = () => w.tabs.called('point').at(-1)[2];
    await w.call('browser_computer', { action: 'left_click', target: { type: 'ref' } });
    assert.deepEqual(pointArg(), { ref: undefined });
    await w.call('browser_computer', { action: 'left_click', target: { ref: 'ref_9' } });
    assert.deepEqual(pointArg(), { ref: 'ref_9' });
    await w.call('browser_computer', { action: 'left_click', target: { x: 3, y: 4 } });
    assert.deepEqual(pointArg(), { coordinate: [3, 4] });
    await w.call('browser_computer', { action: 'left_click', target: { x: 'a' }, coordinate: [7, 8] });
    assert.deepEqual(pointArg(), { coordinate: [7, 8], ref: undefined });
    await w.call('browser_computer', { action: 'left_click', target: 'ref_1', coordinate: [7, 8] });
    assert.deepEqual(pointArg(), { coordinate: [7, 8], ref: undefined });
  });

  test('computer clicking and typing on a read-only site is refused', async () => {
    const w = world();
    w.grants.set('https://r.example', 'read');
    w.tabs.tab.url = 'https://r.example/';
    // the write asks (#1319 G22); the user keeps the site read only
    w.st.answer = { decision: 'allow', scope: 'once', level: 'read' };
    await assert.rejects(
      w.call('browser_computer', { action: 'left_click', coordinate: [1, 1] }),
      code('read_only', /https:\/\/r\.example (is read only for this chat|read-only access)/),
    );
    await assert.rejects(w.call('browser_computer', { action: 'type', text: 'x' }), code('read_only'));
    await assert.rejects(w.call('browser_form_input', { ref: 'ref_1', value: 'x' }), code('read_only'));
    assert.equal(w.tabs.called('click').length + w.tabs.called('typeText').length + w.tabs.called('formInput').length, 0);
    // reading is fine
    await w.call('browser_computer', { action: 'hover', coordinate: [1, 1] });
    assert.equal(w.tabs.called('hover').length, 1);
  });

  test('a site the user lowered to read only on the card: clicks and typing refused this turn without a second card, reads run, the next turn asks again', async () => {
    const w = world();
    // the card offers read and write; the user picks Read only
    w.st.answer = { decision: 'allow', scope: 'once', level: 'read' };
    await w.call('browser_navigate', { url: 'https://docs.example/' });
    assert.deepEqual(
      w.st.asks.map((q: any) => [q.origin, q.need]),
      [['https://docs.example', 'write']],
    );
    w.tabs.tab.url = 'https://docs.example/';
    const refused = code(
      'read_only',
      /^https:\/\/docs\.example is read only for this chat: you can read its pages but not click, type or change anything there\. Don't retry or work around this; ask the user in chat whether to allow read and write/,
    );
    await assert.rejects(w.call('browser_computer', { action: 'left_click', coordinate: [1, 1] }), refused);
    await assert.rejects(w.call('browser_computer', { action: 'type', text: 'x' }), refused);
    await assert.rejects(w.call('browser_form_input', { ref: 'ref_1', value: 'x' }), refused);
    assert.equal(w.tabs.called('click').length + w.tabs.called('typeText').length + w.tabs.called('formInput').length, 0);
    assert.equal(w.st.asks.length, 1, 'no second card this turn');
    await w.call('browser_computer', { action: 'hover', coordinate: [1, 1] });
    assert.equal(w.tabs.called('hover').length, 1, 'reading still works');
    // the next turn (after the agent asked the user): the first click asks again, and read and write lets it run
    w.grants.turnEnded('c1');
    w.st.answer = { decision: 'allow', scope: 'once', level: 'write' };
    await w.call('browser_computer', { action: 'left_click', coordinate: [1, 1] });
    assert.deepEqual(w.st.asks.at(-1), { chatId: 'c1', segmentId: 's1', browser: 'iab', origin: 'https://docs.example', need: 'write' });
    assert.equal(w.tabs.called('click').length, 1);
    await w.call('browser_computer', { action: 'left_click', coordinate: [1, 1] });
    assert.equal(w.st.asks.length, 2);
  });

  test('computer left_click_drag from start_coordinate or from {x,y}, and refuses without a start', async () => {
    const w = world();
    let out = await w.call('browser_computer', { action: 'left_click_drag', start_coordinate: [1, 2], coordinate: [3, 4] });
    assert.equal(first(out), 'Dragged from (1, 2) to (3, 4). Tab t1 is at https://a.example/page (A page).');
    assert.deepEqual(w.tabs.called('drag'), [[w.tabs.tab, { x: 1, y: 2 }, { x: 3, y: 4 }]]);
    assert.equal(w.tabs.called('settle').length, 1);

    w.tabs.impl.drag = async () => 'dialog';
    out = await w.call('browser_computer', { action: 'left_click_drag', from: { x: 5, y: 6 }, target: { x: 7, y: 8 } });
    assert.equal(
      first(out),
      'Dragged from (5, 6) to (7, 8). A dialog or file chooser opened; see browser_state. Tab t1 is at https://a.example/page (A page).',
    );
    assert.equal(w.tabs.called('settle').length, 1);

    await assert.rejects(
      w.call('browser_computer', { action: 'left_click_drag', from: { x: 'a' }, coordinate: [1, 1] }),
      code('bad_args', /needs start_coordinate/),
    );
    await assert.rejects(
      w.call('browser_computer', { action: 'left_click_drag', coordinate: [1, 1] }),
      code('bad_args', /needs start_coordinate/),
    );
    assert.equal(w.tabs.called('drag').length, 2);
  });

  test('computer type and key: counts, repeats, dialogs and missing text', async () => {
    const w = world();
    let out = await w.call('browser_computer', { action: 'type', text: 'a' });
    assert.equal(first(out), 'Typed 1 character. Tab t1 is at https://a.example/page (A page).');
    assert.deepEqual(w.tabs.called('typeText'), [[w.tabs.tab, 'a']]);
    assert.deepEqual(w.tabs.called('settle').at(-1), [w.tabs.tab, { grace: 100 }]);
    out = await w.call('browser_computer', { action: 'type', text: 'abc' });
    assert.match(first(out), /^Typed 3 characters\./);

    out = await w.call('browser_computer', { action: 'key', text: 'Enter' });
    assert.equal(first(out), 'Pressed Enter. Tab t1 is at https://a.example/page (A page).');
    assert.deepEqual(w.tabs.called('keys').at(-1), [w.tabs.tab, 'Enter', 1, { holdMs: 0 }]);
    assert.deepEqual(w.tabs.called('settle').at(-1), [w.tabs.tab, { grace: undefined }]);
    out = await w.call('browser_computer', { action: 'key', text: 'Tab', repeat: 3 });
    assert.match(first(out), /^Pressed Tab ×3\./);
    assert.deepEqual(w.tabs.called('keys').at(-1), [w.tabs.tab, 'Tab', 3, { holdMs: 0 }]);

    const settled = w.tabs.called('settle').length;
    w.tabs.impl.keys = async () => 'dialog';
    out = await w.call('browser_computer', { action: 'key', text: 'Enter', repeat: 1 });
    assert.equal(
      first(out),
      'Pressed Enter. A dialog or file chooser opened; see browser_state. Tab t1 is at https://a.example/page (A page).',
    );
    assert.equal(w.tabs.called('settle').length, settled);

    for (const args of [{ action: 'type' }, { action: 'type', text: '' }, { action: 'key', text: 5 }]) {
      await assert.rejects(w.call('browser_computer', args), code('bad_args', new RegExp(`^${args.action} needs text\\.$`)));
    }
  });

  test('computer rejects an unknown action', async () => {
    const w = world();
    await assert.rejects(
      w.call('browser_computer', { action: 'fly' }),
      code('bad_args', /^Unknown action: fly\. Use one of: left_click, .*, wait\.$/),
    );
  });
}
