// Page-agent geometry unit cases, using the shared DOM and agent fixture.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { win, doc, G, broken, css, box, define, agent, run, shape, load, refAt, frameDoc } from './fixture';

export function registerGeometryCases() {
  test('find matches every query word against role, name, attributes, placeholder and id', () => {
    const $ = load(
      [
        '<input id="email-field" placeholder="Your email"><button>Send mail</button><button>Send fax</button>',
        '<div>Plain words <b>bold</b></div><p aria-hidden="true">Send hidden</p><p hidden>Send hidden2</p><script>send()</script>',
        '<div id=dn>Send none</div><div id=vh><span>Send visible child</span></div><input type="search">',
      ].join(''),
    );
    css($('dn'), { display: 'none' });
    css($('vh'), { visibility: 'hidden' });
    assert.deepEqual(shape(run('find', { query: 'textbox  EMAIL' }).lines), ['- textbox "Your email" [ref]']);
    assert.deepEqual(shape(run('find', { query: 'email-field' }).lines), ['- textbox "Your email" [ref]']);
    assert.deepEqual(shape(run('find', { query: 'send' }).lines), [
      '- button "Send mail" [ref]',
      '- button "Send fax" [ref]',
      '- generic "Send visible child" [ref]',
    ]);
    assert.deepEqual(shape(run('find', { query: 'send', limit: 2 }).lines), ['- button "Send mail" [ref]', '- button "Send fax" [ref]']);
    assert.deepEqual(shape(run('find', { query: 'plain words' }).lines), ['- generic "Plain words" [ref]']);
    assert.deepEqual(shape(run('find', { query: 'searchbox' }).lines), ['- searchbox type=search [ref]']);
    assert.deepEqual(run('find', { query: '   ' }), { lines: [], frames: [] });
    assert.deepEqual(run('find'), { lines: [], frames: [] });
    // the same element keeps one ref between find and tree
    assert.equal(refAt(run('find', { query: 'send mail' }).lines, '- button'), refAt(run('tree').lines, 'button "Send mail"'));
  });

  test('a plain-text element found by its own text can be used by ref until that text changes', () => {
    const $ = load('<div id=plain>Plain words <b>bold</b></div><div id=other>Other words</div>');
    box($('plain'), 10, 20, 100, 20);
    const ref = refAt(run('find', { query: 'plain words' }).lines, '- generic');
    assert.deepEqual([run('locate', { ref, scroll: false }).x, run('locate', { ref, scroll: false }).y], [60, 30]);
    assert.equal(agent.element(ref), $('plain'));
    assert.deepEqual(run('scrollTo', { ref }), { ok: true });
    assert.equal(refAt(run('find', { query: 'plain words' }).lines, '- generic'), ref, 'found again: the same ref');
    // its own text changed: the ref is stale
    $('plain').firstChild.data = 'Changed words ';
    assert.deepEqual(run('locate', { ref }), { error: 'stale', ref });
    // an element that gained a role is no longer the generic match
    const other = refAt(run('find', { query: 'other words' }).lines, '- generic');
    $('other').setAttribute('role', 'button');
    assert.equal(agent.element(other), null);
  });

  test('find searches same-origin frames and reports the others as frame refs', () => {
    const $ = load('<iframe id=same></iframe><iframe id=cross title="Ads"></iframe><iframe id=hid></iframe>');
    frameDoc($('same'), '<button>Inner send</button>');
    define($('cross'), 'contentDocument', {
      get: () => {
        throw new DOMException('Blocked a frame from accessing a cross-origin frame', 'SecurityError');
      },
    });
    define($('hid'), 'contentDocument', { get: () => null });
    css($('hid'), { visibility: 'hidden' });
    const frame = doc.createElement('frame');
    frame.setAttribute('name', 'legacy');
    doc.body.appendChild(frame);
    const out = run('find', { query: 'inner send' });
    assert.deepEqual(shape(out.lines), ['- button "Inner send" [ref]']);
    const tree = run('tree').lines;
    assert.deepEqual(out.frames, [refAt(tree, 'iframe "Ads"'), refAt(tree, 'iframe "legacy"')]);
  });

  test('text prefers substantial main content, else the body, and truncates', () => {
    load(`<header>Top</header><main>${'word '.repeat(60)}</main>`);
    doc.title = 'Page title';
    const main = doc.querySelector('main');
    const long = run('text');
    assert.deepEqual(long, { text: String(main.innerText).trim(), truncated: false, title: 'Page title', url: 'https://site.test/start' });
    assert.ok(long.text.length > 200);

    load('<main>short</main><p>other words</p>');
    const body = String(doc.body.innerText);
    assert.ok(body.includes('other words'));
    assert.equal(run('text').text, body);
    assert.deepEqual(run('text', { maxChars: 5 }), {
      text: body.slice(0, 5),
      truncated: true,
      title: 'Page title',
      url: 'https://site.test/start',
    });

    load('<p>no main here</p>');
    assert.equal(run('text').text, String(doc.body.innerText));

    load('<article>art</article>');
    define(doc.querySelector('article'), 'innerText', { get: () => undefined });
    define(doc.body, 'innerText', { get: () => undefined });
    try {
      assert.equal(run('text').text, '');
    } finally {
      delete doc.body.innerText;
    }

    const bodiless = new win.DOMParser().parseFromString('<html><head><title>T</title></head><body></body></html>', 'text/html');
    bodiless.documentElement.removeChild(bodiless.body);
    G.document = bodiless;
    try {
      assert.deepEqual(run('text'), { text: '', truncated: false, title: 'T', url: 'https://site.test/start' });
    } finally {
      G.document = doc;
    }
  });

  test('locate returns the center and content box of a fully visible element without scrolling', () => {
    const $ = load('<button id=b>Center</button>');
    const b = box($('b'), 100, 200, 80, 30);
    css(b, { paddingLeft: '4px', paddingTop: '2px' });
    define(b, 'clientLeft', { value: 1 });
    define(b, 'clientTop', { value: 3 });
    let scrolled = 0;
    b.scrollIntoView = () => scrolled++;
    const ref = agent.refFor(b).ref;
    assert.deepEqual(run('locate', { ref }), { x: 140, y: 215, w: 80, h: 30, content: { x: 105, y: 205 }, tag: 'button', name: 'Center' });
    assert.equal(scrolled, 0);
    assert.deepEqual(run('locate', { ref: 'ref_999999999' }), { error: 'stale', ref: 'ref_999999999' });
  });

  test('locate scrolls a partly hidden element into view and measures it again', () => {
    const $ = load('<button id=b>Low</button>');
    const b = box($('b'), 10, 760, 40, 20);
    const calls: any[] = [];
    b.scrollIntoView = (opts: any) => {
      calls.push(opts);
      box(b, 10, 374, 40, 20);
    };
    const ref = agent.refFor(b).ref;
    const out = run('locate', { ref });
    assert.deepEqual(calls, [{ block: 'center', inline: 'center', behavior: 'instant' }]);
    assert.deepEqual({ x: out.x, y: out.y }, { x: 30, y: 384 });
    // scroll: false measures in place, for each way of sticking out of the viewport
    for (const [l, t, w, h] of [
      [10, -5, 20, 20],
      [-5, 10, 20, 20],
      [10, 760, 20, 20],
      [1010, 10, 20, 20],
    ]) {
      box(b, l, t, w, h);
      assert.deepEqual(run('locate', { ref, scroll: false }).x, l + w / 2);
    }
    assert.equal(calls.length, 1);
  });

  test('locate falls back to the first client rect for box-less elements', () => {
    const $ = load('<a id=a href="/x">Wrapped</a><a id=b href="/y">Empty</a><a id=c href="/z">Thin</a>');
    $('a').getClientRects = () => [{ left: 5, top: 6, width: 10, height: 8, right: 15, bottom: 14 }];
    $('b').getClientRects = () => [];
    box($('c'), 20, 30, 0, 10);
    $('c').getClientRects = () => assert.fail('a box with a height is used as is');
    assert.deepEqual(run('locate', { ref: agent.refFor($('a')).ref }), {
      x: 10,
      y: 10,
      w: 10,
      h: 8,
      content: { x: 5, y: 6 },
      tag: 'a',
      name: 'Wrapped',
    });
    assert.deepEqual(run('locate', { ref: agent.refFor($('b')).ref }), {
      x: 0,
      y: 0,
      w: 0,
      h: 0,
      content: { x: 0, y: 0 },
      tag: 'a',
      name: 'Empty',
    });
    assert.deepEqual(run('locate', { ref: agent.refFor($('c')).ref }), {
      x: 20,
      y: 35,
      w: 0,
      h: 10,
      content: { x: 20, y: 30 },
      tag: 'a',
      name: 'Thin',
    });
  });

  test('locate tolerates missing styles, unparsable padding and a failing name', () => {
    const $ = load('<button id=nostyle>No style</button><button id=auto>Auto</button><button id=flaky>Flaky</button>');
    broken.add(box($('nostyle'), 10, 10, 20, 20));
    css(box($('auto'), 10, 10, 20, 20), { paddingLeft: 'auto', paddingTop: 'auto' });
    const flaky = box($('flaky'), 10, -100, 20, 20);
    let scrolled = false;
    flaky.scrollIntoView = () => {
      scrolled = true;
      box(flaky, 10, 10, 20, 20);
    };
    define(flaky, 'innerText', {
      get: () => {
        if (scrolled) throw new Error('layout gone');
        return 'Flaky';
      },
    });
    assert.deepEqual(run('locate', { ref: agent.refFor($('nostyle')).ref }), {
      x: 20,
      y: 20,
      w: 20,
      h: 20,
      content: { x: 10, y: 10 },
      tag: 'button',
      name: 'No style',
    });
    assert.deepEqual(run('locate', { ref: agent.refFor($('auto')).ref }).content, { x: 10, y: 10 });
    assert.deepEqual(run('locate', { ref: agent.refFor(flaky).ref }), {
      x: 20,
      y: 20,
      w: 20,
      h: 20,
      content: { x: 10, y: 10 },
      tag: 'button',
      name: '',
      // the name is optional detail: main records why it is missing
      nameError: 'Error: layout gone',
    });
  });

  test('frame probes: only a cross-origin SecurityError means "not readable"; any other failure reaches main', () => {
    const $ = load('<input id=p type=password><iframe id=odd></iframe><button id=b>Go</button>');
    define($('odd'), 'contentDocument', {
      get: () => {
        throw new TypeError('frame torn down');
      },
    });
    assert.throws(() => run('tree'), /frame torn down/);
    // masking skips that frame (and says so) rather than leaving every password field visible
    assert.deepEqual(run('mask'), { count: 1, unreadable: ['TypeError: frame torn down'] });
    assert.match($('p').getAttribute('style'), /color: transparent/);
    run('mask', { on: false });
    const btn = box($('b'), 10, 10, 20, 20);
    define(doc.defaultView, 'frameElement', {
      get: () => {
        throw new TypeError('view gone');
      },
    });
    try {
      assert.throws(() => run('locate', { ref: agent.refFor(btn).ref, scroll: false }), /view gone/);
    } finally {
      delete doc.defaultView.frameElement;
    }
  });

  test('locate adds the offsets of same-origin parent frames, stopping where frameElement throws', () => {
    const $ = load('<iframe id=outer></iframe>');
    const outer = box($('outer'), 100, 50, 600, 400);
    css(outer, { paddingLeft: '5px', paddingTop: 'x' });
    define(outer, 'clientLeft', { value: 2 });
    define(outer, 'clientTop', { value: 3 });
    const outerWin = outer.contentWindow;
    define(outerWin, 'frameElement', { get: () => outer });
    const od = frameDoc(outer, '<iframe id=inner></iframe><button id=ob>Outer btn</button>');
    const inner = box(od.getElementById('inner'), 10, 20, 300, 200);
    broken.add(inner);
    define(inner.contentWindow, 'frameElement', { get: () => inner });
    const id = frameDoc(inner, '<button id=ib>Deep</button>');
    const ib = box(id.getElementById('ib'), 1, 2, 10, 10);
    const ob = box(od.getElementById('ob'), 7, 8, 10, 10);
    const deep = agent.refFor(ib).ref;
    const out = agent.refFor(ob).ref;
    assert.deepEqual(run('locate', { ref: deep, scroll: false }), {
      x: 123,
      y: 80,
      w: 10,
      h: 10,
      content: { x: 118, y: 75 },
      tag: 'button',
      name: 'Deep',
    });
    css(outer, { paddingLeft: 'bogus', paddingTop: '6px' });
    assert.deepEqual(run('locate', { ref: deep, scroll: false }), {
      x: 118,
      y: 86,
      w: 10,
      h: 10,
      content: { x: 113, y: 81 },
      tag: 'button',
      name: 'Deep',
    });
    define(outerWin, 'frameElement', {
      get: () => {
        throw new DOMException('Blocked a frame from accessing a cross-origin frame', 'SecurityError');
      },
    });
    assert.deepEqual(run('locate', { ref: deep, scroll: false }), {
      x: 16,
      y: 27,
      w: 10,
      h: 10,
      content: { x: 11, y: 22 },
      tag: 'button',
      name: 'Deep',
    });
    assert.deepEqual(run('locate', { ref: out, scroll: false }), {
      x: 12,
      y: 13,
      w: 10,
      h: 10,
      content: { x: 7, y: 8 },
      tag: 'button',
      name: 'Outer btn',
    });
    // a frame element in a detached document (its view is null): offsets stop after it
    const detached = {
      getBoundingClientRect: () => ({ left: 40, top: 30 }),
      clientLeft: 0,
      clientTop: 0,
      ownerDocument: { defaultView: null },
    };
    define(outerWin, 'frameElement', { get: () => detached });
    assert.deepEqual(run('locate', { ref: out, scroll: false }).content, { x: 47, y: 38 });
  });

  test('scrollTo centers the element and reports stale refs', () => {
    const $ = load('<button id=b>Far</button>');
    const calls: any[] = [];
    $('b').scrollIntoView = (o: any) => calls.push(o);
    assert.deepEqual(run('scrollTo', { ref: agent.refFor($('b')).ref }), { ok: true });
    assert.deepEqual(calls, [{ block: 'center', inline: 'center', behavior: 'instant' }]);
    assert.deepEqual(run('scrollTo', { ref: 'ref_999999999' }), { error: 'stale', ref: 'ref_999999999' });
  });
}
