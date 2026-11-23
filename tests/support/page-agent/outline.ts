// Page-agent outline unit cases, using the shared DOM and agent fixture.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { spawnSync } from 'node:child_process';
import {
  AGENT_PATH,
  pageAgent,
  PAGE_AGENT_SOURCE,
  SVG,
  win,
  doc,
  G,
  css,
  box,
  define,
  agent,
  run,
  shape,
  load,
  refAt,
  frameDoc,
} from './fixture';

export function registerOutlineCases() {
  test('pageAgent installs one hidden, frozen agent per world and returns it on reinjection', () => {
    assert.equal(pageAgent(), agent);
    const d = Object.getOwnPropertyDescriptor(G, '__mopilotAgent')!;
    assert.equal(d.value, agent);
    assert.equal(d.writable, false);
    assert.equal(d.enumerable, false);
    assert.equal(d.configurable, false);
  });

  test('PAGE_AGENT_SOURCE is self-contained and installs a separate agent in a fresh world', () => {
    load('<button>Go</button>');
    const ctx = vm.createContext({ document: doc, location: win.location, MutationObserver: win.MutationObserver });
    const other = vm.runInContext(PAGE_AGENT_SOURCE, ctx);
    assert.notEqual(other, agent);
    // results come from the other realm, so compare them as plain data
    assert.deepEqual(JSON.parse(JSON.stringify(other.call('find', { query: 'go' }, 0))), {
      value: { lines: ['- button "Go" [ref_1]'], frames: [] },
      seq: 1,
      minted: [['ref_1', 'button', 'Go', 'button']],
      url: 'https://site.test/start',
    });
    assert.equal(vm.runInContext(PAGE_AGENT_SOURCE, ctx), other);
  });

  test('the agent still works when the page has no usable MutationObserver', () => {
    const script = `
    const { pageAgent } = require(${JSON.stringify(AGENT_PATH)});
    Object.assign(globalThis, { document: { visibilityState: 'hidden', readyState: 'loading', title: 'T' }, location: { href: 'https://x.test/' }, innerWidth: 800, innerHeight: 600, devicePixelRatio: 1, scrollX: 3, scrollY: 4 });
    const a = pageAgent();
    process.stdout.write(JSON.stringify([a.call('state', null, 7), a.call('nope')]));`;
    const r = spawnSync(process.execPath, ['-e', script], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    const [st, unknown] = JSON.parse(r.stdout);
    assert.equal(st.seq, 7);
    assert.ok(st.value.quietMs >= 0);
    assert.deepEqual(
      { ...st.value, quietMs: 0 },
      {
        w: 800,
        h: 600,
        dpr: 1,
        sx: 3,
        sy: 4,
        visibility: 'hidden',
        ready: 'loading',
        quietMs: 0,
        mutations: 0,
        // main sees why the page isn't watched, and doesn't wait for a quiet DOM
        observeError: 'ReferenceError: MutationObserver is not defined',
        url: 'https://x.test/',
        title: 'T',
      },
    );
    assert.deepEqual(unknown, { value: { error: 'unknown op nope' }, seq: 7 });
  });

  test('tree outlines landmarks, links, headings and text with indentation; interactive keeps only controls', () => {
    load(
      '<nav aria-label="Main"><a href="/home">Home</a> <a href="javascript:void(0)">Run</a></nav><main><h1>Title</h1><p>Some <b>bold</b> text<br>next line</p><button>Go</button><!-- note --><script>x()</script><style>p{}</style></main>',
    );
    const visible = run('tree');
    assert.equal(visible.truncated, false);
    assert.deepEqual(visible.frames, []);
    assert.deepEqual(shape(visible.lines), [
      '- navigation "Main" [ref]',
      '  - link "Home" href="/home" [ref]',
      '  - link "Run" [ref]',
      '- main [ref]',
      '  - heading "Title" [level=1] [ref]',
      '  - paragraph [ref]',
      '    - text "Some bold text next line"',
      '  - button "Go" [ref]',
    ]);
    const interactive = run('tree', { filter: 'interactive' });
    assert.deepEqual(shape(interactive.lines), ['- link "Home" href="/home" [ref]', '- link "Run" [ref]', '- button "Go" [ref]']);
    // the same elements keep their refs across calls and filters
    assert.equal(refAt(interactive.lines, 'button'), refAt(visible.lines, 'button'));
    assert.equal(refAt(interactive.lines, 'link "Home"'), refAt(run('tree').lines, 'link "Home"'));
  });

  test('tree skips off-screen elements unless fixed, sticky, box-less or filter is all', () => {
    const $ = load(
      '<div id=above>Above</div><div id=left>Left</div><div id=below>Below</div><div id=right>Right</div><div id=fixed>Fixed</div><div id=sticky>Sticky</div><div id=on>On</div><div id=contents><button>In contents</button></div><button id=fb>Fixed button</button>',
    );
    box($('above'), 0, -50, 100, 20);
    box($('left'), -200, 10, 100, 20);
    box($('below'), 0, 800, 100, 20);
    box($('right'), 2000, 10, 100, 20);
    css(box($('fixed'), 0, -100), { position: 'fixed' });
    css(box($('sticky'), 0, 900), { position: 'sticky' });
    box($('on'), 0, 10, 100, 20);
    css(box($('fb'), -500, -500), { position: 'fixed' });
    assert.deepEqual(shape(run('tree').lines), ['- text "Fixed"', '- text "Sticky"', '- text "On"', '- button "In contents" [ref]']);
    assert.deepEqual(shape(run('tree', { filter: 'all' }).lines), [
      '- text "Above"',
      '- text "Left"',
      '- text "Below"',
      '- text "Right"',
      '- text "Fixed"',
      '- text "Sticky"',
      '- text "On"',
      '- button "In contents" [ref]',
      '- button "Fixed button" [ref]',
    ]);
  });

  test('tree never skips the html and body elements as off-screen', () => {
    const $ = load('<div id=wrap></div><div id=gone>Gone</div><iframe id=f title="Frame"></iframe>');
    const nested = doc.createElement('html');
    nested.appendChild(doc.createTextNode('Nested root text'));
    box(nested, 0, -500);
    $('wrap').appendChild(nested);
    box($('gone'), 0, -500);
    const fd = frameDoc($('f'), '<p>Inside frame</p>');
    box(fd.body, 0, 5000);
    assert.deepEqual(shape(run('tree').lines), [
      '- text "Nested root text"',
      '- iframe "Frame" [ref]',
      '  - paragraph [ref]',
      '    - text "Inside frame"',
    ]);
  });

  test('tree stops at the depth limit', () => {
    load('<ul><li>One <a href="/a">A</a></li></ul>');
    assert.deepEqual(shape(run('tree', { depth: 2 }).lines), ['- list [ref]', '  - listitem [ref]']);
    assert.deepEqual(shape(run('tree').lines), [
      '- list [ref]',
      '  - listitem [ref]',
      '    - text "One"',
      '    - link "A" href="/a" [ref]',
    ]);
  });

  test('tree truncates at maxChars and drops later lines and frame placeholders', () => {
    load('<div>Some loose text<button>Bravo</button></div>');
    assert.deepEqual(run('tree', { maxChars: 10 }), { lines: [], frames: [], truncated: true });

    const $ = load('<button>A</button><iframe id=x title="Ads"></iframe>');
    define($('x'), 'contentDocument', { get: () => null });
    const full = run('tree');
    assert.equal(full.lines.length, 3);
    const cut = run('tree', { maxChars: full.lines[0].length + 5 });
    assert.deepEqual(cut, { lines: [full.lines[0]], frames: full.frames, truncated: true });
  });

  test('tree from a ref outlines that subtree, and reports stale refs', () => {
    const $ = load('<ul id=list><li>One</li><li>Two</li></ul><p>outside</p><div id=plain>Loose <button>Btn</button></div>');
    const listRef = refAt(run('tree').lines, 'list');
    assert.deepEqual(shape(run('tree', { ref: listRef }).lines), [
      '- list [ref]',
      '  - listitem [ref]',
      '    - text "One"',
      '  - listitem [ref]',
      '    - text "Two"',
    ]);
    // a role-less element (as refFor hands out for frame owners) outlines its children
    const { ref: plainRef } = agent.refFor($('plain'));
    assert.deepEqual(shape(run('tree', { ref: plainRef }).lines), ['- text "Loose"', '- button "Btn" [ref]']);
    assert.deepEqual(run('tree', { ref: 'ref_999999999' }), { error: 'stale', ref: 'ref_999999999' });
    $('list').remove();
    assert.deepEqual(run('tree', { ref: listRef }), { error: 'stale', ref: listRef });
  });

  test('refs stay stable until an element changes role or name', () => {
    const $ = load('<button id=b>Save</button>');
    const r1 = refAt(run('tree').lines, 'button');
    assert.equal(refAt(run('tree').lines, 'button'), r1);
    assert.equal(agent.element(r1), $('b'));
    $('b').textContent = 'Saved';
    assert.equal(agent.element(r1), null);
    const r2 = refAt(run('tree').lines, 'button "Saved"');
    assert.notEqual(r2, r1);
    assert.equal(agent.element(r2), $('b'));
    $('b').setAttribute('role', 'tab');
    assert.equal(agent.element(r2), null);
    assert.equal(agent.element('ref_999999999'), null);
  });

  test('tree walks same-origin frames inline and leaves placeholders for the others', () => {
    const $ = load(
      '<iframe id=same title="Inner"></iframe><iframe id=cross name="ads"></iframe><iframe id=nulldoc></iframe><iframe id=emptydoc></iframe>',
    );
    frameDoc($('same'), '<button>Inside</button>');
    define($('cross'), 'contentDocument', {
      get: () => {
        throw new DOMException('Blocked a frame from accessing a cross-origin frame', 'SecurityError');
      },
    });
    define($('nulldoc'), 'contentDocument', { get: () => null });
    define($('emptydoc'), 'contentDocument', { get: () => ({ documentElement: null }) });
    const out = run('tree');
    const cross = refAt(out.lines, 'iframe "ads"');
    const nulldoc = out.lines[4].match(/\[(ref_\d+)\]$/)[1];
    const emptydoc = out.lines[6].match(/\[(ref_\d+)\]$/)[1];
    assert.deepEqual(out.frames, [cross, nulldoc, emptydoc]);
    assert.deepEqual(
      out.lines.map((l: string) => l.replace(/ref_\d+/g, 'ref')),
      [
        '- iframe "Inner" [ref]',
        '  - button "Inside" [ref]',
        '- iframe "ads" [ref]',
        '\u0001FRAME ref 1\u0001',
        '- iframe [ref]',
        '\u0001FRAME ref 1\u0001',
        '- iframe [ref]',
        '\u0001FRAME ref 1\u0001',
      ],
    );
    const interactive = run('tree', { filter: 'interactive' });
    assert.deepEqual(interactive.lines, [
      out.lines[1].trimStart(),
      `\u0001FRAME ${cross} 0\u0001`,
      `\u0001FRAME ${nulldoc} 0\u0001`,
      `\u0001FRAME ${emptydoc} 0\u0001`,
    ]);
  });

  test('tree follows shadow roots and slots, including fallback and non-HTML slots', () => {
    const $ = load('<div id=host><span>Light child</span></div><div id=empty-host></div>');
    $('host').attachShadow({ mode: 'open' }).innerHTML = '<button>Shadow</button><slot></slot>';
    $('empty-host').attachShadow({ mode: 'open' }).innerHTML = '<slot><em>Fallback</em></slot>';
    const foreign = doc.createElementNS(SVG, 'slot');
    foreign.appendChild(doc.createTextNode('Foreign slot'));
    doc.body.appendChild(foreign);
    assert.deepEqual(shape(run('tree').lines), [
      '- button "Shadow" [ref]',
      '- text "Light child"',
      '- text "Fallback"',
      '- text "Foreign slot"',
    ]);
  });

  test('tree hides aria-hidden, hidden, display:none and visibility-hidden elements', () => {
    const $ = load(
      '<div aria-hidden="true"><button>Aria</button></div><div hidden><button>Attr</button></div><div id=none><button>None</button></div><div id=vh><button>Shown</button></div><button id=hb aria-label="Invisible"></button><a id=vc href="/c" aria-label="Collapsed"></a><p>visible</p>',
    );
    css($('none'), { display: 'none' });
    css($('vh'), { visibility: 'hidden' });
    css($('hb'), { visibility: 'hidden' });
    css($('vc'), { visibility: 'collapse' });
    assert.deepEqual(shape(run('tree', { filter: 'all' }).lines), ['- button "Shown" [ref]', '- paragraph [ref]', '  - text "visible"']);
  });

  test('tree splits text at block boundaries and mutes text already used as a name', () => {
    const $ = load(
      '<div>first<div>second</div>third</div><span>in</span><span>line</span><button><span>Label</span> text</button><button id=empty><svg></svg></button><a href="/x">Link <b>bold</b></a><div id=ib>inline <span>block</span></div>',
    );
    css($('ib'), { display: 'inline-block' });
    assert.deepEqual(shape(run('tree').lines), [
      '- text "first"',
      '- text "second"',
      '- text "third"',
      '- text "inline"',
      '- button "Label text" [ref]',
      '- button [ref]',
      '- link "Link bold" href="/x" [ref]',
      '- text "inline block"',
    ]);
  });

  test('tree marks a cut text run or name with how much was left out, never a bare ellipsis (#3571 Codex × IAB)', () => {
    const body = `Start date: the first Monday ${'x'.repeat(380)}`;
    load(`<div>${body}</div><a href="/m/1">${'n'.repeat(200)}</a><div>short</div><a href="/m/2">${'k'.repeat(150)}</a>`);
    assert.deepEqual(shape(run('tree', { filter: 'all' }).lines), [
      `- text "${body.slice(0, 299)}… [+${body.length - 299} chars]"`,
      `- link "${'n'.repeat(149)}… [+51 chars]" href="/m/1" [ref]`,
      '- text "short"',
      `- link "${'k'.repeat(150)}" href="/m/2" [ref]`,
    ]);
    // find shows the same line as the tree, so a find does not change the page diff's baseline for that ref
    const tree = run('tree', { filter: 'all' }).lines.find((l: string) => l.startsWith('- link "nnn'));
    assert.equal(run('find', { query: 'nnnn' }).lines[0], tree);
    assert.equal(run('find', { query: 'short' }).lines[0].startsWith('- generic "short"'), true);
  });

  test('tree and find degrade gracefully when computed styles are unavailable', () => {
    const bare = doc.implementation.createHTMLDocument('bare');
    bare.body.innerHTML = '<span>a</span><span>b</span><div>c</div><button>Btn</button>';
    G.document = bare;
    try {
      assert.deepEqual(shape(run('tree').lines), ['- text "a"', '- text "b"', '- text "c"', '- button "Btn" [ref]']);
      assert.deepEqual(shape(run('find', { query: 'btn' }).lines), ['- button "Btn" [ref]']);
    } finally {
      G.document = doc;
    }
  });

  test('tree and find return nothing for a document without a root element', () => {
    const empty = doc.implementation.createHTMLDocument('empty');
    empty.removeChild(empty.documentElement);
    G.document = empty;
    try {
      assert.deepEqual(run('tree'), { lines: [], frames: [], truncated: false });
      assert.deepEqual(run('find', { query: 'x' }), { lines: [], frames: [] });
    } finally {
      G.document = doc;
    }
  });
}
