// Page-agent locators unit cases, using the shared DOM and agent fixture.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { query, doc, broken, css, box, define, agent, load, frameDoc } from './fixture';

export function registerLocatorsCases() {
  /** The ids (or tags) of what the steps match. */
  const ids = (steps: any[]) => {
    const out = query(steps);
    assert.ok(out.refs, JSON.stringify(out));
    return out.refs.map((r: string) => {
      const el = agent.element(r);
      return el.id || el.localName;
    });
  };
  const sub = (s: string, exact = false) => ({ s, exact });

  test('query: CSS under the document and open shadow roots; later steps search under what matched', () => {
    const $ = load('<div id=a><button id=b1>One</button></div><div id=c><button id=b2>Two</button></div><span id=host></span>');
    $('host').attachShadow({ mode: 'open' }).innerHTML = '<button id=b3>Three</button>';
    assert.deepEqual(ids([{ k: 'css', s: 'button' }]), ['b1', 'b2', 'b3']);
    assert.deepEqual(
      ids([
        { k: 'css', s: '#c' },
        { k: 'css', s: 'button' },
      ]),
      ['b2'],
    );
    // the host's own shadow root is searched too
    assert.deepEqual(
      ids([
        { k: 'css', s: '#host' },
        { k: 'css', s: 'button' },
      ]),
      ['b3'],
    );
    const out = query([{ k: 'css', s: 'button' }], 2);
    assert.deepEqual([out.refs.length, out.count, out.desc], [2, 3, ['button "One"', 'button "Two"', 'button "Three"']]);
    // no steps: the document itself, which is no element
    assert.deepEqual(query([]), { refs: [], count: 0, desc: [] });
    assert.match(query([{ k: 'css', s: '[[[' }]).error, /^Invalid locator: .*not a valid selector/);
    assert.deepEqual(query([{ k: 'zz' }]), { error: 'Invalid locator: unknown locator step "zz"' });
  });

  test('query: Playwright CSS extensions :has-text, :text, :text-is and :visible filter the selector before them', () => {
    const $ = load('<div id=d1><button id=b1>Save draft</button></div><div id=d2><button id=b2>Save</button></div><p id=p1>hidden</p>');
    box($('b1'), 0, 0);
    box($('d1'), 0, 0);
    assert.deepEqual(ids([{ k: 'css', s: 'button:has-text("save")' }]), ['b1', 'b2']);
    assert.deepEqual(ids([{ k: 'css', s: "div:has-text('draft')" }]), ['d1']);
    assert.deepEqual(ids([{ k: 'css', s: 'button:text-is("Save")' }]), ['b2']);
    assert.deepEqual(ids([{ k: 'css', s: 'button:text("save")' }]), ['b1', 'b2']);
    // the smallest element holding the text wins, so its container doesn't match :text
    assert.deepEqual(ids([{ k: 'css', s: 'div:text("save")' }]), []);
    assert.deepEqual(ids([{ k: 'css', s: 'button:visible' }]), ['b1']);
    assert.deepEqual(ids([{ k: 'css', s: ':visible' }]), ['d1', 'b1']);
    assert.deepEqual(ids([{ k: 'css', s: 'div > :visible:has-text("Save")' }]), ['b1']);
    assert.deepEqual(ids([{ k: 'css', s: 'p:has-text("a \\"quoted\\" word")' }]), []);
  });

  test('query: XPath from the document, or relative to each element matched so far; only elements count', () => {
    const $ = load('<div id=a><span id=s1>x</span></div>');
    const calls: any[] = [];
    define(doc, 'evaluate', {
      value: (expr: string, root: any, _ns: any, type: number) => {
        calls.push([expr, root === doc ? 'doc' : root.id, type]);
        const items = [$('s1'), doc.createTextNode('t'), $('s1')];
        return { snapshotLength: items.length, snapshotItem: (i: number) => items[i] };
      },
    });
    try {
      assert.deepEqual(ids([{ k: 'xpath', s: '//span' }]), ['s1']);
      assert.deepEqual(
        ids([
          { k: 'css', s: '#a' },
          { k: 'xpath', s: '//span' },
        ]),
        ['s1'],
      );
      assert.deepEqual(
        ids([
          { k: 'css', s: '#a' },
          { k: 'xpath', s: 'span' },
        ]),
        ['s1'],
      );
      assert.deepEqual(calls, [
        ['//span', 'doc', 7],
        ['.//span', 'a', 7],
        ['span', 'a', 7],
      ]);
    } finally {
      delete doc.evaluate;
    }
  });

  test('query: text matches the smallest elements holding it: substring, exact, RegExp, button values; never scripts', () => {
    load(
      '<div id=d><p id=p>Hello <b id=b>big</b> World</p><script>Hello World</script><input id=sub type=submit value="Hello World"><span id=s>hello world!</span><input id=untyped></div>',
    );
    assert.deepEqual(ids([{ k: 'text', m: sub('hello world') }]), ['sub', 's']);
    assert.deepEqual(ids([{ k: 'text', m: sub('Hello big World', true) }]), ['p']);
    assert.deepEqual(ids([{ k: 'text', m: sub('hello world', true) }]), []);
    assert.deepEqual(ids([{ k: 'text', m: { re: '^hello', flags: 'gi' } }]), ['p', 'sub', 's']);
    assert.deepEqual(ids([{ k: 'text', m: { re: 'big' } }]), ['b']);
  });

  test('query: getByRole matches implicit roles, names and states, and leaves out what assistive tech does not see', () => {
    const $ = load(`
    <button id=save>Save</button><button id=saveas>Save as</button><button id=off disabled>Off</button>
    <input id=q type=search placeholder="Search"><input id=name aria-label="Name">
    <input id=cb type=CHECKBOX checked aria-label="Agree"><div id=mixed role=checkbox aria-checked=mixed>Partial</div><div id=no role=checkbox aria-checked=false>No</div><div id=yes role=checkbox aria-checked=true>Yes</div><div id=none role=checkbox>None</div>
    <h2 id=h2>Title</h2><div id=h4 role=heading aria-level=4>Four</div><div id=hx role=heading>Default</div>
    <button id=exp aria-expanded=true aria-pressed=true>Menu</button><select id=sel><option id=o1>A</option><option id=o2 selected>B</option></select><div id=tab role=tab aria-selected=true>T</div>
    <div aria-hidden=true><button id=ah>Hidden1</button></div><button id=hid hidden>Hidden2</button><button id=dn>Hidden3</button><button id=vh>Hidden4</button>
    <span id=host></span>`);
    css($('dn'), { display: 'none' });
    css($('vh'), { visibility: 'hidden' });
    const sr = $('host').attachShadow({ mode: 'open' });
    sr.innerHTML = '<button id=inner>Shadow</button>';
    assert.deepEqual(ids([{ k: 'role', role: 'button', name: sub('save') }]), ['save', 'saveas']);
    assert.deepEqual(ids([{ k: 'role', role: 'button', name: sub('Save', true) }]), ['save']);
    assert.deepEqual(ids([{ k: 'role', role: 'button', name: { re: 'as$' } }]), ['saveas']);
    assert.deepEqual(ids([{ k: 'role', role: 'button', disabled: true }]), ['off']);
    assert.deepEqual(ids([{ k: 'role', role: 'textbox' }]), ['q', 'name'], 'a textbox includes search fields');
    assert.deepEqual(ids([{ k: 'role', role: 'searchbox' }]), ['q']);
    assert.deepEqual(ids([{ k: 'role', role: 'checkbox', checked: true }]), ['cb', 'yes']);
    assert.deepEqual(ids([{ k: 'role', role: 'checkbox', checked: 'mixed' }]), ['mixed']);
    assert.deepEqual(ids([{ k: 'role', role: 'checkbox', checked: false }]), ['no']);
    assert.deepEqual(ids([{ k: 'role', role: 'heading', level: 2 }]), ['h2', 'hx']);
    assert.deepEqual(ids([{ k: 'role', role: 'heading', level: 4 }]), ['h4']);
    assert.deepEqual(ids([{ k: 'role', role: 'button', expanded: true, pressed: true }]), ['exp']);
    assert.deepEqual(ids([{ k: 'role', role: 'option', selected: true }]), ['o2']);
    assert.deepEqual(ids([{ k: 'role', role: 'tab', selected: true }]), ['tab']);
    assert.deepEqual(ids([{ k: 'role', role: 'button', name: sub('hidden') }]), []);
    assert.deepEqual(ids([{ k: 'role', role: 'button', name: sub('hidden'), includeHidden: true }]), ['ah', 'hid', 'dn', 'vh']);
    assert.deepEqual(ids([{ k: 'role', role: 'button', name: sub('shadow') }]), ['inner']);
    // a shadow host hidden from assistive tech hides its shadow content
    $('host').setAttribute('aria-hidden', 'true');
    assert.deepEqual(ids([{ k: 'role', role: 'button', name: sub('shadow') }]), []);
    // without computed styles the role is still found
    broken.add($('save'));
    assert.deepEqual(ids([{ k: 'role', role: 'button', name: sub('Save', true) }]), ['save']);
  });

  test('query: labels, placeholders, alt, title and test ids', () => {
    load(`
    <label for=email>Email address</label><input id=email>
    <label>Phone <input id=phone></label>
    <span id=lbl>Card number</span><input id=card aria-labelledby="missing lbl">
    <input id=zip aria-label="Postal code" placeholder="e.g. 12345">
    <img id=logo alt="Company logo"><span id=tip title="More info">?</span><div id=t1 data-testid=submit-btn></div><div id=t2 data-testid=submit></div>`);
    assert.deepEqual(ids([{ k: 'label', m: sub('email') }]), ['email']);
    assert.deepEqual(ids([{ k: 'label', m: sub('phone') }]), ['phone']);
    assert.deepEqual(ids([{ k: 'label', m: sub('card number', false) }]), ['card']);
    assert.deepEqual(ids([{ k: 'label', m: sub('Postal code', true) }]), ['zip']);
    assert.deepEqual(ids([{ k: 'attr', name: 'placeholder', m: sub('12345') }]), ['zip']);
    assert.deepEqual(ids([{ k: 'attr', name: 'alt', m: sub('logo') }]), ['logo']);
    assert.deepEqual(ids([{ k: 'attr', name: 'title', m: sub('more info', false) }]), ['tip']);
    assert.deepEqual(ids([{ k: 'attr', name: 'data-testid', m: sub('submit', true) }]), ['t2']);
  });

  test('query: nth, visible, filter, and, or, and refs', () => {
    const $ = load(
      '<ul><li id=l1>Apple <button id=x1>Buy</button></li><li id=l2>Banana <i id=bad>sold out</i></li><li id=l3>Cherry <button id=x3>Buy</button></li></ul>',
    );
    box($('l1'), 0, 0);
    const li = { k: 'css', s: 'li' };
    assert.deepEqual(ids([li, { k: 'nth', i: 0 }]), ['l1']);
    assert.deepEqual(ids([li, { k: 'nth', i: -1 }]), ['l3']);
    assert.deepEqual(ids([li, { k: 'nth', i: 5 }]), []);
    assert.deepEqual(ids([li, { k: 'visible', v: true }]), ['l1']);
    assert.deepEqual(ids([li, { k: 'visible', v: false }]), ['l2', 'l3']);
    assert.deepEqual(ids([li, { k: 'filter', hasText: sub('an') }]), ['l2']);
    assert.deepEqual(ids([li, { k: 'filter', hasNotText: sub('sold') }]), ['l1', 'l3']);
    assert.deepEqual(ids([li, { k: 'filter', has: [{ k: 'css', s: 'button' }] }]), ['l1', 'l3']);
    assert.deepEqual(ids([li, { k: 'filter', hasNot: [{ k: 'css', s: 'button' }] }]), ['l2']);
    assert.deepEqual(ids([li, { k: 'filter', visible: true }]), ['l1']);
    assert.deepEqual(ids([li, { k: 'filter' }]), ['l1', 'l2', 'l3']);
    assert.deepEqual(ids([li, { k: 'and', steps: [{ k: 'text', m: sub('cherry') }] }]), ['l3']);
    assert.deepEqual(ids([li, { k: 'and', steps: [{ k: 'css', s: '#l3' }] }]), ['l3']);
    assert.deepEqual(
      ids([
        { k: 'css', s: '#l3' },
        { k: 'or', steps: [{ k: 'css', s: 'zz, #l1' }] },
      ]),
      ['l1', 'l3'],
    );
    assert.deepEqual(
      ids([
        { k: 'css', s: '#x3' },
        { k: 'or', steps: [{ k: 'css', s: '#l1' }] },
      ]),
      ['l1', 'x3'],
    );
    const ref = agent.refFor($('x3')).ref;
    assert.deepEqual(ids([{ k: 'ref', ref }]), ['x3']);
    assert.deepEqual(ids([{ k: 'ref', ref: 'ref_999999999' }]), []);
  });

  test('query: frame steps enter one same-origin frame, hand back cross-origin ones, and refuse ambiguity', () => {
    const $ = load(
      '<iframe id=f1 title="One"></iframe><iframe id=f2 title="Two"></iframe><div id=notframe>x</div><iframe id=x title="Ads"></iframe><iframe id=thrower></iframe>',
    );
    const fd = frameDoc($('f1'), '<button id=fb>Inside</button><p id=fp>Para</p>');
    const frame = (sel: string) => [{ k: 'css', s: sel }, { k: 'frame' }];
    assert.deepEqual(query([...frame('#f1'), { k: 'css', s: 'button' }]).desc, ['button "Inside"']);
    // later and/or steps start from the frame's document
    assert.deepEqual(query([...frame('#f1'), { k: 'css', s: 'button' }, { k: 'or', steps: [{ k: 'css', s: 'p' }] }]).count, 2);
    assert.equal(fd.getElementById('fb').localName, 'button');
    assert.deepEqual(query([...frame('#nothing'), { k: 'css', s: 'button' }]), { refs: [], count: 0, desc: [] });
    const two = query([...frame('iframe[title]'), { k: 'css', s: 'button' }]);
    assert.deepEqual(
      [two.strict, two.error],
      [true, 'The frame locator matched 3 elements (iframe "One", iframe "Two", iframe "Ads"). Use .first() or .nth(i).'],
    );
    assert.deepEqual(query([...frame('#notframe')]), { error: 'The frame locator matched <div#notframe> "x", which is not a frame.' });
    define($('x'), 'contentDocument', { get: () => null });
    const hop = query([...frame('#x'), { k: 'css', s: 'button' }]);
    assert.deepEqual(hop, { hop: agent.refFor($('x')).ref, rest: [{ k: 'css', s: 'button' }] });
    define($('thrower'), 'contentDocument', {
      get: () => {
        throw new DOMException('Blocked a frame from accessing a cross-origin frame', 'SecurityError');
      },
    });
    assert.deepEqual(query([...frame('#thrower')]).rest, []);
  });
}
