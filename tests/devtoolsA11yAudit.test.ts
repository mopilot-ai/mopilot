// The page-side accessibility audit (devtools/a11yAudit.cjs): every rule's violation and pass case, the maxNodes / rules / selector options, hidden-subtree skipping, contrast incompletes, sorting, and that no field value ever leaves the page.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { Window } from 'happy-dom';

const require = createRequire(import.meta.url);
const { a11yAudit, A11Y_AUDIT_SOURCE, RULES } = require('../electron/capabilities/browser/devtools/a11yAudit.cjs');

/** Builds a full document; the body defaults to a clean main landmark with an h1 around `body`. */
function doc(body: string, o: { lang?: string | null; title?: string; head?: string; raw?: boolean } = {}) {
  const lang = o.lang === null ? '' : ` lang="${o.lang ?? 'en'}"`;
  const inner = o.raw ? body : `<main><h1>Home</h1>${body}</main>`;
  return `<!doctype html><html${lang} style="color:rgb(0,0,0)"><head><title>${o.title ?? 'Title'}</title>${o.head ?? ''}</head><body style="background-color:rgb(255,255,255)">${inner}</body></html>`;
}

/** Runs the real function against `html` with happy-dom's document as the global, restoring the globals afterwards. */
function run(html: string, opts: any = {}, after?: (d: any) => void): any {
  const win = new Window({ url: 'https://example.test/page' });
  win.document.write(html);
  after?.(win.document);
  const g = globalThis as any;
  const saved = { document: g.document, getComputedStyle: g.getComputedStyle };
  g.document = win.document;
  g.getComputedStyle = (el: any) => win.getComputedStyle(el);
  try {
    return a11yAudit(opts);
  } finally {
    g.document = saved.document;
    g.getComputedStyle = saved.getComputedStyle;
  }
}
const hit = (html: string, id: string, opts: any = {}) => run(html, { rules: [id], ...opts }).violations.find((v: any) => v.id === id);

/** One document per rule that must trigger it. */
const CASES: Record<string, string> = {
  'image-alt': doc('<img src="a.png">'),
  'input-image-alt': doc('<input type="image" src="a.png">'),
  'input-button-name': doc('<input type="button">'),
  'area-alt': doc('<map name="m"><area href="/x" shape="rect" coords="0,0,1,1"></map>'),
  'svg-img-alt': doc('<svg role="img"></svg>'),
  label: doc('<input type="text">'),
  'button-name': doc('<button></button>'),
  'link-name': doc('<a href="/x"></a>'),
  'document-title': doc('', { title: '' }),
  'html-has-lang': doc('', { lang: null }),
  'html-lang-valid': doc('', { lang: 'english_US' }),
  'duplicate-id-aria': doc('<span id="d">a</span><span id="d">b</span><input aria-labelledby="d">'),
  'aria-valid-attr': doc('<div aria-foo="1"></div>'),
  'aria-required-attr': doc('<div role="slider"></div>'),
  'aria-hidden-focus': doc('<div aria-hidden="true"><button>x</button></div>'),
  'heading-order': doc('<h3>Skipped</h3>'),
  'page-has-heading-one': doc('<main><h2>x</h2></main>', { raw: true }),
  'landmark-one-main': doc('<h1>x</h1>', { raw: true }),
  'frame-title': doc('<iframe></iframe>'),
  tabindex: doc('<div tabindex="3">x</div>'),
  'meta-viewport': doc('', { head: '<meta name="viewport" content="width=device-width, user-scalable=no">' }),
  list: doc('<ul><div>x</div></ul>'),
  listitem: doc('<li>x</li>'),
  'color-contrast': doc('<p style="color:rgb(200,200,200);background-color:rgb(255,255,255)">low</p>'),
  'autocomplete-valid': doc('<input aria-label="n" autocomplete="nope">'),
};

test('RULES is frozen, matches the rules the function runs, and each id has a triggering case', () => {
  assert.ok(Object.isFrozen(RULES));
  assert.deepEqual(Object.keys(CASES).sort(), [...RULES].sort());
  const all = run(doc(''));
  assert.equal(all.rulesRun, RULES.length);
  for (const id of RULES) {
    const v = hit(CASES[id], id);
    assert.ok(v, `${id} should trigger`);
    assert.ok(v.count >= 1 && v.nodes.length >= 1 && v.nodes[0].why && v.nodes[0].selector && v.nodes[0].html.startsWith('<'));
    assert.ok(['critical', 'serious', 'moderate', 'minor'].includes(v.impact) && v.help && Array.isArray(v.wcag));
  }
  const everything = Object.values(CASES).flatMap((h) => run(h).violations.map((v: any) => v.id));
  assert.ok(everything.every((id: string) => RULES.includes(id)));
});

test('a clean page passes every rule with each accessible-name source', () => {
  const html = doc(
    `<h2>Sub</h2><h3 role="heading" aria-level="3">Deeper</h3>
    <img src="a" alt="x"><img src="b" alt=""><img src="c" role="presentation"><img src="d" title="t">
    <input type="image" alt="Go" src="a"><input type="button" value="Ok"><input type="submit"><input type="hidden">
    <map name="m"><area href="/x" alt="Area"></map><svg role="img" aria-label="logo"></svg>
    <label for="e">Email</label><input id="e" autocomplete="section-a shipping email">
    <label>Name <input></label><select aria-label="s"></select><textarea placeholder="Notes"></textarea><input title="t">
    <span id="lab">Lbl</span><input aria-labelledby="missing lab">
    <button>Go</button><a href="/x"><img src="i" alt="Home"></a><button aria-label="x"></button><iframe title="f"></iframe>
    <div role="checkbox" aria-checked="false"></div><input role="checkbox" aria-label="c"><select role="combobox" aria-label="s2"></select>
    <ul><li>a</li><script></script></ul><menu><li>x</li></menu><div role="list"><li>y</li></div>
    <div tabindex="0">t</div><div tabindex="-1">t</div><div role="heading" aria-level="4">h</div>
    <input autocomplete="" aria-label="a"><input autocomplete="off" aria-label="b"><input autocomplete="username webauthn" aria-label="c2">
    <div aria-hidden="true"><span tabindex="-1">x</span><a>no href</a><p>text</p></div>
    <p style="color:rgb(0,0,0);background-color:transparent">ok</p>`,
    { head: '<meta name="viewport" content="width=device-width, maximum-scale=5"><meta name="viewport2" content="x">' },
  );
  const r = run(html);
  assert.deepEqual(r.violations, []);
  assert.deepEqual(r.incomplete, []);
  assert.equal(r.passes, RULES.length);
  assert.equal(r.url, 'https://example.test/page');
  assert.equal(r.title, 'Title');
});

test('rule specifics: names, roles and attributes', () => {
  assert.equal(hit(doc('<img src="a" aria-label="x"><img src="b" role="img">'), 'image-alt').count, 1);
  assert.equal(
    hit(doc('<button title="t"></button><div role="button"></div><button><img alt="Go"></button><button>  </button>'), 'button-name').count,
    2,
  );
  assert.equal(hit(doc('<a href="/x" aria-labelledby="n"></a><span id="n"></span>'), 'link-name').count, 1);
  assert.equal(hit(doc('<a>no href</a><div role="link"></div>'), 'link-name').count, 1);
  assert.equal(
    hit(doc('<input type="checkbox"><select></select><textarea></textarea><input type="submit"><input type="reset">'), 'label').count,
    3,
  );
  assert.equal(hit(doc('<input role="none"><input role="presentation">'), 'label'), undefined);
  assert.equal(hit(doc('<h2>x</h2><h4>y</h4><h2>z</h2><h3>w</h3>'), 'heading-order').count, 1);
  assert.equal(hit(doc('<div role="heading">a</div><div role="heading" aria-level="5">b</div>'), 'heading-order').count, 1);
  assert.equal(
    hit(
      doc('<div role="slider"></div><div role="checkbox"></div><div role="combobox"></div><div role="heading"></div>'),
      'aria-required-attr',
    ).count,
    4,
  );
  assert.equal(hit(doc('<input role="slider"><div role="slider checkbox" aria-valuenow="1"></div>'), 'aria-required-attr'), undefined);
  assert.equal(hit(doc('', { lang: 'en-US' }), 'html-lang-valid'), undefined);
  assert.equal(hit(doc('', { lang: ' ' }), 'html-has-lang').count, 1);
  assert.equal(hit(doc('', { title: '  ' }), 'document-title').count, 1);
  assert.equal(hit(doc('<h1>one</h1>'), 'page-has-heading-one'), undefined);
  assert.equal(hit(doc('<div role="heading" aria-level="1">x</div>', { raw: true }), 'page-has-heading-one'), undefined);
  assert.equal(hit(doc('<main></main><div role="main"></div>', { raw: true }), 'landmark-one-main').count, 2);
  assert.equal(hit(doc('<div tabindex="0"></div><div tabindex="x"></div>'), 'tabindex'), undefined);
  assert.equal(
    hit(
      doc('<span id="a"></span><span id="a"></span><label for="a">x</label><input aria-describedby="a b" aria-label="q">'),
      'duplicate-id-aria',
    ).count,
    2,
  );
  assert.equal(hit(doc('<span id="a"></span><p aria-labelledby="zz">x</p>'), 'duplicate-id-aria'), undefined);
  assert.equal(hit(doc('<p aria-label="x" aria-hidden="false" aria-sort="none" data-aria-x="1">x</p>'), 'aria-valid-attr'), undefined);
  assert.match(hit(doc('<p aria-bogus="1">x</p>'), 'aria-valid-attr').nodes[0].why, /aria-bogus/);
  assert.equal(hit(doc('', { head: '<meta name="viewport" content="maximum-scale=1.0">' }), 'meta-viewport').count, 1);
  assert.equal(hit(doc('', { head: '<meta name="viewport" content="user-scalable = 0">' }), 'meta-viewport').count, 1);
  assert.equal(hit(doc('<ol><li>a</li><p>x</p></ol><ul><template></template></ul>'), 'list').count, 1);
  assert.equal(hit(doc('<div role="list"><li>a</li></div><ol><li>a</li></ol><menu><li>a</li></menu>'), 'listitem'), undefined);
  assert.equal(hit(doc('<input aria-label="x" autocomplete="section-blue billing home tel webauthn">'), 'autocomplete-valid'), undefined);
  assert.equal(
    hit(
      doc(
        '<input aria-label="x" autocomplete="tel webauthn extra"><input aria-label="y" autocomplete="shipping"><input aria-label="z" autocomplete="tel nope">',
      ),
      'autocomplete-valid',
    ).count,
    3,
  );
});

test('aria-hidden-focus decides focusability per element type', () => {
  const body = `<div aria-hidden="true"><button>b</button><a href="/x">l</a><area href="/y"><input aria-label="i"><input type="hidden"><button disabled>d</button>
    <span tabindex="0">t</span><span tabindex="-1">n</span><div contenteditable="true">e</div><div>plain</div><a>nohref</a><textarea></textarea><select></select></div>`;
  const v = hit(doc(body), 'aria-hidden-focus');
  assert.equal(v.count, 8);
});

test('hidden subtrees are skipped by the visible-element rules', () => {
  const body = `<div style="display:none"><img src="a"><p style="visibility:visible"><img src="b"></p></div>
    <p style="visibility:hidden"><img src="c"></p><div hidden><img src="d"></div><div aria-hidden="true"><img src="e"><div style="display:none"><button>x</button></div></div>`;
  assert.equal(hit(doc(body), 'image-alt'), undefined);
  assert.equal(hit(doc(body), 'aria-hidden-focus'), undefined);
  assert.equal(hit(doc('<img src="v" style="visibility:visible">'), 'image-alt').count, 1);
});

test('color-contrast: ratios, large text, translucent backgrounds, and incomplete cases', () => {
  const gray = 'color:rgb(140,140,140);background-color:rgb(255,255,255)';
  assert.equal(hit(doc(`<p style="${gray}">small</p>`), 'color-contrast').count, 1);
  assert.match(hit(doc(`<p style="${gray}">small</p>`), 'color-contrast').nodes[0].why, /needs 4.5:1/);
  assert.equal(hit(doc(`<p style="${gray};font-size:24px">big</p>`), 'color-contrast'), undefined);
  assert.equal(
    hit(
      doc(`<p style="${gray};font-size:19px;font-weight:bold">b</p><p style="${gray};font-size:19px;font-weight:700">b</p>`),
      'color-contrast',
    ),
    undefined,
  );
  assert.equal(hit(doc(`<p style="${gray};font-size:19px;font-weight:400">n</p>`), 'color-contrast').count, 1);
  assert.equal(hit(doc('<p style="color:rgb(0 0 0 / 0.5);background-color:rgba(255,255,255,1)">half</p>'), 'color-contrast').count, 1);
  assert.equal(
    hit(doc('<div style="background-color:rgba(0,0,0,0.9)"><p style="color:rgb(250,250,250)">on dark</p></div>'), 'color-contrast'),
    undefined,
  );
  assert.equal(
    hit(
      doc('<div style="background-color:rgb(0,0,0)"><p style="color:rgb(10,10,10);background-color:rgba(0,0,0,0)">dark on dark</p></div>'),
      'color-contrast',
    ).count,
    1,
  );
  const r = run(
    doc(`<div style="background-image:url(a.png)"><p>image</p></div><p style="color:red">named</p><p style="color:rgba(0,0,0,0)">ghost</p>
    <div style="background-color:rebeccapurple"><p style="color:rgb(0,0,0)">bg</p></div><div style="background-image:linear-gradient(red,blue)"><p style="color:rgb(0,0,0)">g</p></div>
    <script>var x = 1;</script><p> </p>`),
    { rules: ['color-contrast'] },
  );
  assert.deepEqual(r.violations, []);
  assert.equal(r.incomplete[0].id, 'color-contrast');
  assert.equal(r.incomplete[0].count, 5);
  assert.deepEqual(r.incomplete[0].nodes.map((n: any) => n.why).slice(0, 3), [
    'Background is an image or could not be parsed',
    'Text color could not be parsed',
    'Text is transparent',
  ]);
  assert.equal(r.passes, 0);
  const two = doc('<p style="color:rgb(250,250,250)">a</p><p style="color:rgb(250,250,250)">b</p>');
  assert.equal(run(two, { rules: ['color-contrast'] }).violations[0].count, 2);
  const capped = run(two, { rules: ['color-contrast'], maxContrast: 2 });
  assert.ok((capped.violations[0]?.count ?? 0) < 2);
  const bare = '<!doctype html><html style="color:rgb(0,0,0)"><body><p>no backgrounds anywhere</p></body></html>';
  assert.deepEqual(run(bare, { rules: ['color-contrast'] }).violations, []);
});

test('maxNodes caps the nodes but not the count; defaults and bad values', () => {
  const body = '<img src="a">'.repeat(12);
  const v = hit(doc(body), 'image-alt');
  assert.equal(v.count, 12);
  assert.equal(v.nodes.length, 10);
  assert.equal(hit(doc(body), 'image-alt', { maxNodes: 2 }).nodes.length, 2);
  assert.equal(hit(doc(body), 'image-alt', { maxNodes: 0.4 }).nodes.length, 1);
  assert.equal(hit(doc(body), 'image-alt', { maxNodes: -3 }).nodes.length, 10);
  assert.equal(hit(doc(body), 'image-alt', { maxNodes: 'x' }).nodes.length, 10);
});

test('rules filter limits what runs; unknown ids and no options', () => {
  const html = doc('<img src="a"><button></button>');
  const only = run(html, { rules: ['image-alt', 'label', 'nope'] });
  assert.equal(only.rulesRun, 2);
  assert.deepEqual(
    only.violations.map((v: any) => v.id),
    ['image-alt'],
  );
  assert.equal(only.passes, 1);
  assert.equal(run(html, { rules: ['nope'] }).rulesRun, 0);
  assert.equal(run(html, { rules: [] }).rulesRun, RULES.length);
  assert.equal(run(html).rulesRun, RULES.length);
  assert.equal(
    run(html, null).violations.some((v: any) => v.id === 'button-name'),
    true,
  );
});

test('selector scopes the audit to one subtree and skips document-level rules', () => {
  const html = doc('<section id="in"><img src="a"><h4>x</h4></section><img src="b">', { lang: null, title: '' });
  const scoped = run(html, { selector: '#in' });
  assert.equal(scoped.violations.find((v: any) => v.id === 'image-alt').count, 1);
  for (const id of ['document-title', 'html-has-lang', 'page-has-heading-one', 'landmark-one-main'])
    assert.equal(
      scoped.violations.some((v: any) => v.id === id),
      false,
    );
  assert.equal(run(html).violations.find((v: any) => v.id === 'image-alt').count, 2);
  const self = run(doc('<button id="b"></button>'), { selector: 'button' });
  assert.equal(self.violations[0].id, 'button-name');
  const none = run(html, { selector: '#missing' });
  assert.equal(none.error, 'selector matched no element');
  assert.equal(none.rulesRun, 0);
  assert.deepEqual(none.violations, []);
});

test('selectors are short and unique; html is the opening tag only and capped', () => {
  const deep = '<div><div><div><div><div><div><div><b id="x y"></b><img src="a"></div></div></div></div></div></div></div>';
  const n = hit(doc(deep + '<img id="dup" src="b"><img id="dup" src="c"><img id="ok" src="d"><img id="9" src="e">'), 'image-alt').nodes;
  assert.equal(n[0].selector.split(' > ').length, 5);
  assert.match(
    n[0].selector,
    /^div:nth-of-type\(1\) > div:nth-of-type\(1\) > div:nth-of-type\(1\) > div:nth-of-type\(1\) > img:nth-of-type\(1\)$/,
  );
  assert.match(n[1].selector, /main:nth-of-type\(1\) > img:nth-of-type\(1\)$/);
  assert.match(n[2].selector, /img:nth-of-type\(2\)$/);
  assert.equal(n[3].selector, '#ok');
  assert.match(n[4].selector, /img:nth-of-type\(4\)$/);
  const long = hit(doc(`<img src="a" data-x="${'z'.repeat(300)}">`), 'image-alt').nodes[0].html;
  assert.equal(long.length, 160);
  assert.ok(long.endsWith('…'));
  assert.equal(hit(doc('<img  src="a"\n alt2="  s  ">'), 'image-alt').nodes[0].html, '<img src="a" alt2=" s ">');
});

test('no field value is ever returned; password tags keep only type/name/id/class', () => {
  const body = `<input type="password" name="pw" id="pw" class="c" value="hunter2" data-token="tok-123" autocomplete="bogus-token">
    <input type="text" id="user" value="alice@example.com" autocomplete="nope"><textarea id="ta" autocomplete="zz">draft text</textarea>
    <select id="s" autocomplete="zz"><option value="opt-secret" selected>Chosen</option></select>`;
  const r = run(doc(body), {}, (d) => {
    d.getElementById('user').value = 'typed-live-value';
    d.getElementById('ta').value = 'typed-in-textarea';
  });
  const json = JSON.stringify(r);
  for (const secret of ['hunter2', 'tok-123', 'alice@example.com', 'typed-live-value', 'typed-in-textarea', 'opt-secret'])
    assert.equal(json.includes(secret), false, secret);
  const pw = r.violations.find((v: any) => v.id === 'autocomplete-valid').nodes.find((x: any) => x.selector === '#pw');
  assert.equal(pw.html, '<input type="password" name="pw" id="pw" class="c">');
  assert.equal(
    r.violations
      .find((v: any) => v.id === 'label')
      .nodes.find((x: any) => x.selector === '#user')
      .html.includes('value'),
    false,
  );
});

test('violations are sorted by impact then by count', () => {
  const body =
    '<img src="a"><img src="b"><img src="c"><button></button><a href="/x"></a><h3>skip</h3><ul><div></div></ul><ul><div></div></ul>';
  const r = run(doc(body));
  assert.deepEqual(
    r.violations.map((v: any) => v.id),
    ['image-alt', 'button-name', 'list', 'link-name', 'heading-order'],
  );
  assert.deepEqual(
    r.violations.map((v: any) => v.count),
    [3, 1, 2, 1, 1],
  );
});

test('A11Y_AUDIT_SOURCE evaluates to the same function', () => {
  const fn = (0, eval)(A11Y_AUDIT_SOURCE);
  assert.equal(typeof fn, 'function');
  assert.equal(fn.toString(), a11yAudit.toString());
  assert.equal(A11Y_AUDIT_SOURCE, `(${a11yAudit.toString()})`);
});
