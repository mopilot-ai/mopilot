// Page-agent inspection unit cases, using the shared DOM and agent fixture.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { query, doc, broken, css, box, define, agent, run, load } from './fixture';

export function registerInspectionCases() {
  test('describe (in messages): role and name, a role alone, or the tag with its id and text', () => {
    const $ = load('<ul id=u></ul><div id=d>Some text</div><div></div><b>Bold</b>');
    assert.deepEqual(query([{ k: 'css', s: 'ul, div, b' }]).desc, ['list', '<div#d> "Some text"', '<div>', '<b> "Bold"']);
    assert.equal($('u').localName, 'ul');
  });

  test('inspect: element state, texts, attributes and input values; stale refs are null', () => {
    const $ = load(`
    <input id=t value="typed"><input id=cb type=checkbox checked><input id=ro readonly value=r><input id=aro aria-readonly=true>
    <textarea id=ta>area</textarea><div id=ce contenteditable=true>edit</div><div id=plain>plain <b>bold</b></div>
    <fieldset disabled><input id=fsin><div id=fsdiv>in fieldset</div></fieldset><div aria-disabled=true><button id=ad>A</button></div>
    <div id=mixed role=checkbox aria-checked=mixed></div><select id=s><option value=v1>One</option></select><input id=hid type=hidden>`);
    box($('t'), 0, 0);
    const one = (id: string, what: string, name?: string) => run('inspect', { refs: [agent.refFor($(id)).ref], what, name })[0];
    assert.deepEqual(one('t', 'state'), { visible: true, enabled: true, editable: true, checked: null, tag: 'input', type: '' });
    assert.deepEqual(one('cb', 'state'), { visible: false, enabled: true, editable: false, checked: true, tag: 'input', type: 'checkbox' });
    assert.equal(one('ro', 'state').editable, false);
    assert.equal(one('aro', 'state').editable, false);
    assert.equal(one('ta', 'state').editable, true);
    assert.equal(one('ce', 'state').editable, true);
    assert.equal(one('plain', 'state').editable, false);
    assert.deepEqual([one('fsin', 'state').enabled, one('fsdiv', 'state').enabled, one('ad', 'state').enabled], [false, true, false]);
    assert.equal(one('mixed', 'state').checked, 'mixed');
    assert.equal(one('hid', 'state').editable, false);
    css($('t'), { visibility: 'hidden' });
    assert.equal(one('t', 'state').visible, false);
    broken.add($('ta'));
    assert.equal(one('ta', 'state').visible, false, 'no style: decided by the box alone');
    assert.equal(one('plain', 'innerText'), 'plain bold');
    define($('plain'), 'innerText', { value: undefined });
    assert.equal(one('plain', 'innerText'), 'plain bold');
    assert.equal(one('plain', 'textContent'), 'plain bold');
    assert.equal(one('plain', 'innerHTML'), 'plain <b>bold</b>');
    assert.equal(one('t', 'attr', 'value'), 'typed');
    assert.equal(one('t', 'attr', 'nope'), null);
    assert.equal(one('t', 'value'), 'typed');
    assert.equal(one('ta', 'value'), 'area');
    assert.equal(one('s', 'value'), 'v1');
    assert.deepEqual(one('plain', 'value'), { error: 'inputValue needs an input, textarea or select element, not <div>.' });
    assert.deepEqual(one('t', 'bogus'), { error: 'unknown property bogus' });
    assert.deepEqual(run('inspect', { refs: ['ref_999999999'], what: 'state' }), [null]);
    assert.deepEqual(run('inspect'), []);
  });

  test('focus focuses the element; select picks options of a native select by value, label or index', () => {
    const $ = load(
      '<input id=i><select id=s><option value=a>Apple</option><option value=b>Banana</option></select><select id=m multiple><option value=x>X</option><option value=y>Y</option><option value=z>Z</option></select><div id=d>no</div>',
    );
    assert.deepEqual(run('focus', { ref: agent.refFor($('i')).ref }), { ok: true });
    assert.equal(doc.activeElement, $('i'));
    assert.deepEqual(run('focus', { ref: 'ref_999999999' }), { error: 'stale', ref: 'ref_999999999' });
    const events: string[] = [];
    $('s').addEventListener('input', () => events.push('input'));
    $('s').addEventListener('change', () => events.push('change'));
    const s = agent.refFor($('s')).ref;
    assert.deepEqual(run('select', { ref: s, wants: ['b'] }), { ok: true, values: ['b'] });
    assert.deepEqual(run('select', { ref: s, wants: [' Apple '] }), { ok: true, values: ['a'] });
    assert.deepEqual(run('select', { ref: s, wants: [{ index: 1 }] }), { ok: true, values: ['b'] });
    assert.deepEqual(run('select', { ref: s, wants: [{ value: 'a', label: 'Apple' }] }), { ok: true, values: ['a'] });
    assert.deepEqual(events, ['input', 'change', 'input', 'change', 'input', 'change', 'input', 'change']);
    assert.deepEqual(run('select', { ref: s, wants: [{ label: 'Cherry' }] }), {
      error: 'No option matches {"label":"Cherry"}. Options: "Apple" (a), "Banana" (b)',
    });
    assert.deepEqual(run('select', { ref: s, wants: ['a', 'b'] }), { error: 'This <select> takes one option.' });
    const m = agent.refFor($('m')).ref;
    assert.deepEqual(run('select', { ref: m, wants: ['x', 'Z'] }), { ok: true, values: ['x', 'z'] });
    assert.deepEqual(
      [...$('m').selectedOptions].map((o: any) => o.value),
      ['x', 'z'],
    );
    assert.deepEqual(run('select', { ref: m }), { ok: true, values: [] });
    assert.deepEqual(run('select', { ref: agent.refFor($('d')).ref, wants: ['a'] }), {
      error: 'selectOption needs a <select> element, not <div#d> "no". For a custom dropdown, click it and then click the option.',
    });
    assert.deepEqual(run('select', { ref: 'ref_999999999' }), { error: 'stale', ref: 'ref_999999999' });
    assert.deepEqual(run('focus'), { error: 'stale', ref: undefined });
  });

  test('locate with hit reports what covers the center: nothing, the element itself or its content, its label, or another element', () => {
    const $ = load(
      '<button id=b><span id=inner>Go</span></button><label id=lab for=cb>Agree</label><input id=cb type=checkbox><div id=over>Overlay</div><span id=host></span>',
    );
    const b = box($('b'), 10, 10, 40, 20);
    const sr = $('host').attachShadow({ mode: 'open' });
    sr.innerHTML = '<i id=deep>deep</i>';
    let under: any = null;
    const points: any[] = [];
    define(doc, 'elementFromPoint', { value: (x: number, y: number) => (points.push([x, y]), under) });
    try {
      const ref = agent.refFor(b).ref;
      const cover = () => run('locate', { ref, hit: true }).cover;
      assert.equal(cover(), null);
      assert.deepEqual(points, [[30, 20]]);
      under = b;
      assert.equal(cover(), null);
      under = $('inner');
      assert.equal(cover(), null);
      under = $('over');
      assert.equal(cover(), '<div#over> "Overlay"');
      assert.equal(run('locate', { ref }).cover, undefined, 'only asked for with hit');
      // a label for the element takes the click for it
      const cb = agent.refFor(box($('cb'), 0, 0, 10, 10)).ref;
      under = $('lab');
      assert.equal(run('locate', { ref: cb, hit: true }).cover, null);
      under = $('lab');
      assert.equal(cover(), '<label#lab> "Agree"');
      // shadow roots are entered while they say what is under the point (when they can)
      under = $('host');
      assert.equal(cover(), '<span#host>');
      define(sr, 'elementFromPoint', { value: () => sr.getElementById('deep') });
      assert.equal(cover(), '<i#deep> "deep"');
      define(sr, 'elementFromPoint', { value: () => $('host') });
      assert.equal(cover(), '<span#host>');
      define(sr, 'elementFromPoint', { value: () => null });
      assert.equal(cover(), '<span#host>');
      // the element inside a shadow root, under the point through its host
      const deepRef = agent.refFor(box(sr.getElementById('deep'), 0, 0, 10, 10)).ref;
      define(sr, 'elementFromPoint', { value: () => sr.getElementById('deep') });
      assert.equal(run('locate', { ref: deepRef, hit: true }).cover, null);
    } finally {
      delete doc.elementFromPoint;
    }
  });
}
