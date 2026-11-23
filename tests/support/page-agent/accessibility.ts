// Page-agent accessibility unit cases, using the shared DOM and agent fixture.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { doc, styles, broken, css, define, agent, run, shape, load } from './fixture';

export function registerAccessibilityCases() {
  test('reserved page tag and input-type names retain generic and textbox roles', () => {
    load(
      '<constructor>Custom element</constructor><input type="__proto__" aria-label="Reserved"><input type="constructor" aria-label="Other">',
    );
    const lines = shape(run('tree', { filter: 'all' }).lines);
    assert.ok(
      lines.some((line: string) => line.startsWith('- textbox "Reserved" ')),
      JSON.stringify(lines),
    );
    assert.ok(
      lines.some((line: string) => line.startsWith('- textbox "Other" ')),
      JSON.stringify(lines),
    );
    assert.ok(lines.includes('- text "Custom element"'));
    assert.ok(lines.every((line: string) => !line.includes('[object Object]') && !line.includes('function ')));
  });

  test('roles: explicit roles, links, areas and the none/presentation/generic fallbacks', () => {
    load(
      '<button role="none">Btn none</button><h2 role="presentation">Pres</h2><nav role="generic" aria-label="Gen nav"></nav><div role="tab button" aria-selected="true">Tab one</div><a>no href</a><map><area href="/r" alt="Region"><area alt="Dead"></map><span role="link">Span link</span>',
    );
    assert.deepEqual(shape(run('tree', { filter: 'all' }).lines), [
      '- button "Btn none" [ref]',
      '- heading "Pres" [level=2] [ref]',
      '- navigation "Gen nav" [ref]',
      '- tab "Tab one" [selected] [ref]',
      '- text "no href"',
      '- link "Region" href="/r" [ref]',
      '- link "Span link" [ref]',
    ]);
  });

  test('roles, names and states of input types', () => {
    const $ = load(
      [
        '<input type="hidden" value="h">',
        '<input placeholder="Search here">',
        '<input type="EMAIL" value="a@b.c" required>',
        '<input type="text" value="plain">',
        '<input type="password" value="hunter2" aria-label="Pass">',
        '<input type="search" value="q">',
        '<input list="dl" value="c">',
        '<input type="number" value="5">',
        '<input type="range" value="7">',
        '<input type="checkbox" checked aria-label="Agree">',
        '<input type="radio" aria-label="Pick">',
        '<input type="checkbox" disabled aria-label="Off">',
        '<input type="submit">',
        '<input type="reset">',
        '<input type="button">',
        '<input type="button" value="Press">',
        '<input type="image" alt="Find">',
        '<input type="image" value="Img value">',
        '<input type="file">',
        '<input type="color">',
        `<input aria-label="Long" value="${'v'.repeat(250)}">`,
      ].join(''),
    );
    void $;
    assert.deepEqual(shape(run('tree', { filter: 'all' }).lines), [
      '- textbox "Search here" [ref]',
      '- textbox value="a@b.c" type=email [required] [ref]',
      '- textbox value="plain" [ref]',
      '- textbox "Pass" value="••••" type=password [ref]',
      '- searchbox value="q" type=search [ref]',
      '- combobox value="c" [ref]',
      '- spinbutton value="5" type=number [ref]',
      '- slider value="7" type=range [ref]',
      '- checkbox "Agree" [checked] [ref]',
      '- radio "Pick" [unchecked] [ref]',
      '- checkbox "Off" [unchecked] [disabled] [ref]',
      '- button "Submit" [ref]',
      '- button "Reset" [ref]',
      '- button [ref]',
      '- button "Press" [ref]',
      '- button "Find" [ref]',
      '- button "Img value" [ref]',
      '- button [ref]',
      '- button [ref]',
      `- textbox "Long" value="${'v'.repeat(199)}… [+51 chars]" [ref]`,
    ]);
  });

  test('a file input shows the files it holds, so an upload can be checked (#1653)', () => {
    const $ = load(
      '<input id=none type=file aria-label="Empty"><input id=one type=file aria-label="One"><input id=many type=file multiple aria-label="Many">',
    );
    const files = (...names: string[]) => ({
      length: names.length,
      [Symbol.iterator]: () => names.map((name) => ({ name }))[Symbol.iterator](),
    });
    define($('none'), 'files', { value: files() });
    define($('one'), 'files', { value: files('invoice-email.png') });
    define($('many'), 'files', { value: files('a.png', 'b "quoted".pdf') });
    assert.deepEqual(shape(run('tree', { filter: 'all' }).lines), [
      '- button "Empty" [ref]',
      '- button "One" files="invoice-email.png" [ref]',
      '- button "Many" files="a.png, b \\"quoted\\".pdf" [ref]',
    ]);
  });

  test('names from labels, placeholders, aria-labelledby, textareas and selects', () => {
    const $ = load(
      [
        '<label for=l1>Email label</label><input id=l1>',
        '<label id=hl for=l2>Hidden label</label><input id=l2>',
        '<label for=l3></label><input id=l3 placeholder="Ph">',
        '<span id=lbl>Labelled</span><section aria-labelledby="missing lbl"></section>',
        '<button aria-labelledby="nope">Fallback</button>',
        '<section aria-label="Intro"></section><section>plain section</section>',
        '<textarea aria-label="Bio">Hello</textarea>',
        '<select aria-label="Size"><option>S</option><option selected>M</option></select>',
        '<select multiple aria-label="Multi"></select>',
        '<select id=sized aria-label="Sized"><option>x</option></select>',
      ].join(''),
    );
    define($('hl'), 'innerText', { get: () => '' });
    $('sized').size = 4;
    assert.deepEqual(shape(run('tree', { filter: 'all' }).lines), [
      '- text "Email label"',
      '- textbox "Email label" [ref]',
      '- text "Hidden label"',
      '- textbox "Hidden label" [ref]',
      '- textbox "Ph" [ref]',
      '- text "Labelled"',
      '- region "Labelled" [ref]',
      '- button "Fallback" [ref]',
      '- region "Intro" [ref]',
      '- text "plain section"',
      '- textbox "Bio" value="Hello" [ref]',
      '  - text "Hello"',
      '- combobox "Size" value="M" [ref]',
      '  - option "S" [ref]',
      '  - option "M" [selected] [ref]',
      '- listbox "Multi" [ref]',
      '- listbox "Sized" value="x" [ref]',
      '  - option "x" [selected] [ref]',
    ]);
  });

  test('headings, images, svg, fieldsets, tables, figures and content-named elements', () => {
    load(
      [
        '<h3>Three</h3><div role="heading" aria-level="4">Four</div><div role="heading">Def</div>',
        '<img alt=""><img alt="Cat"><img title="T only">',
        '<svg aria-label="Logo"></svg><svg><title>Chart</title></svg><svg role="img"></svg><svg><g role="button"><text>Close</text></g></svg>',
        '<fieldset><legend>Shipping</legend></fieldset><fieldset title="No legend"></fieldset>',
        '<table><caption>Prices</caption><tr><th>H</th><td>D</td></tr></table><table title="Untitled"></table>',
        '<figure><figcaption>Fig 1</figcaption></figure><figure title="Bare fig"></figure>',
        '<a href="/pic"><img alt="Logo pic"></a><button title="Tip"></button>',
        '<button>say "hi" \\ there</button>',
      ].join(''),
    );
    assert.deepEqual(shape(run('tree', { filter: 'all' }).lines), [
      '- heading "Three" [level=3] [ref]',
      '- heading "Four" [level=4] [ref]',
      '- heading "Def" [level=2] [ref]',
      '- img "Cat" [ref]',
      '- img "T only" [ref]',
      '- img "Logo" [ref]',
      '- img "Chart" [ref]',
      '- img [ref]',
      '- button "Close" [ref]',
      '- group "Shipping" [ref]',
      '  - legend "Shipping" [ref]',
      '- group "No legend" [ref]',
      '- table "Prices" [ref]',
      '  - caption "Prices" [ref]',
      '  - row [ref]',
      '    - columnheader "H" [ref]',
      '    - cell "D" [ref]',
      '- table "Untitled" [ref]',
      '- figure "Fig 1" [ref]',
      '  - text "Fig 1"',
      '- figure "Bare fig" [ref]',
      '- link "Logo pic" href="/pic" [ref]',
      '  - img "Logo pic" [ref]',
      '- button "Tip" [ref]',
      '- button "say \\"hi\\" \\\\ there" [ref]',
    ]);
  });

  test('editable regions, clickables and ARIA states', () => {
    const $ = load(
      [
        '<div contenteditable="true">Edit <b>me</b></div><div contenteditable="true"></div><div role="textbox">Fake</div>',
        '<div onclick="x()">Do it</div><div tabindex="0">Focusable</div><div tabindex="-1">Not focusable</div>',
        '<div id=ptr>Pointer<span id=ptrc>child</span></div><div><span id=ptr2>Inner pointer</span></div><div id=bp><span id=bpc>Broken parent</span></div>',
        '<button disabled>Dis</button><div role="button" aria-disabled="true" aria-expanded="true">Menu</div><button aria-expanded="false">More</button>',
        '<div role="switch" aria-checked="true">Wifi</div><div role="menuitemcheckbox">Bold</div><div role="menuitemradio" aria-checked="true">Left</div>',
        `<button>${'n'.repeat(200)}</button>`,
      ].join(''),
    );
    css($('ptr'), { cursor: 'pointer' });
    css($('ptrc'), { cursor: 'pointer' });
    css($('ptr2'), { cursor: 'pointer' });
    css($('bpc'), { cursor: 'pointer' });
    broken.add($('bp'));
    assert.deepEqual(shape(run('tree', { filter: 'all' }).lines), [
      '- textbox value="Edit me" [ref]',
      '  - text "Edit me"',
      '- textbox [ref]',
      '- textbox [ref]',
      '  - text "Fake"',
      '- clickable "Do it" [ref]',
      '- clickable "Focusable" [ref]',
      '- text "Not focusable"',
      '- clickable "Pointerchild" [ref]',
      '- clickable "Inner pointer" [ref]',
      '- clickable "Broken parent" [ref]',
      '- button "Dis" [disabled] [ref]',
      '- button "Menu" [disabled] [expanded] [ref]',
      '- button "More" [collapsed] [ref]',
      '- switch "Wifi" [checked] [ref]',
      '- menuitemcheckbox "Bold" [unchecked] [ref]',
      '- menuitemradio "Left" [checked] [ref]',
      `- button "${'n'.repeat(149)}… [+51 chars]" [ref]`,
    ]);
  });

  test('the root element can be clickable or editable without a parent', () => {
    load('<p>body</p>');
    const html = doc.documentElement;
    html.setAttribute('aria-label', 'Root');
    css(html, { cursor: 'pointer' });
    try {
      const { ref } = agent.refFor(html);
      assert.deepEqual(shape(run('tree', { ref, depth: 1 }).lines), ['- clickable "Root" [ref]']);
      styles.delete(html);
      html.setAttribute('contenteditable', 'true');
      define(html, 'innerText', { get: () => 'Root text' });
      const { ref: editRef } = agent.refFor(html);
      assert.notEqual(editRef, ref);
      assert.deepEqual(shape(run('tree', { ref: editRef, depth: 1 }).lines), ['- textbox "Root" value="Root text" [ref]']);
    } finally {
      styles.delete(html);
      html.removeAttribute('aria-label');
      html.removeAttribute('contenteditable');
      delete html.innerText;
    }
  });

  test('refFor names a hidden input whose labels list is null, as browsers report', () => {
    const $ = load('<label>Secret<input id=h type=hidden value="x"></label>');
    define($('h'), 'labels', { get: () => null });
    const { ref } = agent.refFor($('h'));
    assert.equal(agent.element(ref), $('h'));
    assert.deepEqual(run('tree', { ref }), { lines: [], frames: [], truncated: false });
  });
}
