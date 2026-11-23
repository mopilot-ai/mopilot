// Browser pane Annotate mode (IAB-06): the pure mark model (src/lib/pageAnnotations.ts), the in-page
// overlay (src/lib/annotateOverlay.ts, run here against a happy-dom page), main (its isolated world and
// the region capture, electron/capabilities/browser/annotate.cjs), and the send path: a chip reaches
// Codex, Claude Code and ACP through the attachment path they already share.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { Window } from 'happy-dom';
import {
  excerpt,
  isSecretField,
  cssSelector,
  roleOf,
  accessibleName,
  describeElement,
  viewportRect,
  cropRect,
  describeMarks,
  safeUrl,
  annotationText,
  pageAnnotationAttachment,
  expandPageAnnotations,
  TEXT_LIMIT,
  CROP_PAD,
  type RawPage,
  type RawElement,
} from '../src/lib/pageAnnotations.ts';
import { annotateOverlay, annotateScripts, readSignal, ANNOTATE_KEY } from '../src/lib/annotateOverlay.ts';

const require = createRequire(import.meta.url);
const {
  captureRegion,
  captureRect,
  isPaneTab,
  runOverlay,
  registerCapture,
  MAX_SIDE,
  ANNOTATE_WORLD,
  MAX_SCRIPT,
} = require('../electron/capabilities/browser/annotate.cjs');
const { buildInput } = require('../electron/harness/codex.cjs');
const { buildClaudeMessage } = require('../electron/harness/claude/message.cjs');
const { acpBlocks } = require('../electron/harness/acpTurns.cjs');

const node = (tag: string, extra: any = {}) => ({ tag, nth: 1, ofType: 1, ...extra });
const el = (extra: Partial<RawElement> = {}): RawElement => ({ tag: 'div', chain: [node('div'), node('body')], ...extra });

/* ------------------------------------------------------------------ */
/* pure model                                                          */
/* ------------------------------------------------------------------ */
test('excerpts collapse whitespace and truncate with an ellipsis', () => {
  assert.equal(excerpt('  a \n\t b  '), 'a b');
  assert.equal(excerpt(undefined), '');
  assert.equal(excerpt(null), '');
  const long = 'x'.repeat(TEXT_LIMIT + 20);
  assert.equal(excerpt(long).length, TEXT_LIMIT);
  assert.ok(excerpt(long).endsWith('…'));
  assert.equal(excerpt('abcdef', 4), 'abc…');
});

test('password, hidden and autofill-secret fields are secret; ordinary fields are not', () => {
  assert.equal(isSecretField({ tag: 'input', type: 'password' }), true);
  assert.equal(isSecretField({ tag: 'input', type: 'HIDDEN' }), true);
  assert.equal(isSecretField({ tag: 'input' }), false);
  assert.equal(isSecretField({ tag: 'input', type: 'text', autocomplete: 'current-password' }), true);
  assert.equal(isSecretField({ tag: 'input', type: 'text', autocomplete: 'one-time-code' }), true);
  assert.equal(isSecretField({ tag: 'input', type: 'text', autocomplete: 'billing cc-number' }), true);
  assert.equal(isSecretField({ tag: 'input', type: 'text', autocomplete: 'email' }), false);
  assert.equal(isSecretField({ tag: 'textarea' }), false);
});

test('selectors anchor at a unique id or test id, else a tag path from body with nth-of-type, never classes', () => {
  assert.equal(
    cssSelector([node('button', { nth: 2, ofType: 3 }), node('form', { id: 'login', idUnique: true }), node('body')]),
    '#login > button:nth-of-type(2)',
  );
  assert.equal(cssSelector([node('span'), node('div', { id: '1 odd"id', idUnique: true })]), 'div[id="1 odd\\"id"] > span');
  assert.equal(
    cssSelector([node('a', { id: 'dup', idUnique: false }), node('li', { testId: 'row\\x', testIdUnique: true })]),
    'li[data-testid="row\\\\x"] > a',
  );
  assert.equal(
    cssSelector([node('A', { testId: 'shared', testIdUnique: false }), node('main'), node('BODY'), node('html')]),
    'body > main > a',
  );
  assert.equal(cssSelector([node('html')]), 'html');
  assert.equal(
    cssSelector([node('td', { nth: 4, ofType: 5 }), node('tr', { nth: 2, ofType: 9 })]),
    'tr:nth-of-type(2) > td:nth-of-type(4)',
  );
  assert.equal(cssSelector([]), '');
});

test('roles come from the role attribute, else the tag (and input type), else generic', () => {
  assert.equal(roleOf({ tag: 'div', role: ' tab  presentation' }), 'tab');
  assert.equal(roleOf({ tag: 'a', href: 'https://x.test/' }), 'link');
  assert.equal(roleOf({ tag: 'a' }), 'generic');
  assert.equal(roleOf({ tag: 'input' }), 'textbox');
  assert.equal(roleOf({ tag: 'input', type: 'CHECKBOX' }), 'checkbox');
  assert.equal(roleOf({ tag: 'input', type: 'color' }), 'textbox');
  assert.equal(roleOf({ tag: 'H2' }), 'heading');
  assert.equal(roleOf({ tag: 'span' }), 'generic');
});

test('accessible names prefer labelling attributes, then text for roles named by content', () => {
  assert.equal(accessibleName(el({ tag: 'button', ariaLabel: ' Close ', text: 'X' })), 'Close');
  assert.equal(accessibleName(el({ tag: 'div', labelledBy: 'Billing', title: 't' })), 'Billing');
  assert.equal(accessibleName(el({ tag: 'input', label: 'Email', placeholder: 'you@' })), 'Email');
  assert.equal(accessibleName(el({ tag: 'img', alt: 'Logo' })), 'Logo');
  assert.equal(accessibleName(el({ tag: 'input', placeholder: 'Search' })), 'Search');
  assert.equal(accessibleName(el({ tag: 'button', text: '  Save   draft ' })), 'Save draft');
  assert.equal(accessibleName(el({ tag: 'div', text: 'Just text' })), undefined);
  assert.equal(accessibleName(el({ tag: 'button' })), undefined);
});

test('a described element carries role, name, text, value and selector, but nothing from a secret field', () => {
  const button = describeElement(
    el({ tag: 'BUTTON', text: 'Sign in', chain: [node('button'), node('form', { id: 'f', idUnique: true })] }),
  );
  assert.deepEqual(button, { tag: 'button', role: 'button', name: 'Sign in', selector: '#f > button' });
  const link = describeElement(el({ tag: 'a', href: 'https://x.test/docs', text: 'Read the docs please', title: 'Docs' }));
  assert.deepEqual(link, {
    tag: 'a',
    role: 'link',
    name: 'Docs',
    text: 'Read the docs please',
    href: 'https://x.test/docs',
    selector: 'body > div',
  });
  const field = describeElement(el({ tag: 'input', type: 'email', label: 'Email', value: '  me@x.test ' }));
  assert.equal(field.value, 'me@x.test');
  const secret = describeElement(el({ tag: 'input', type: 'password', label: 'Password', value: 'hunter2', text: 'hunter2' }));
  assert.deepEqual(secret, { tag: 'input', role: 'textbox', name: 'Password', selector: 'body > div' });
  assert.ok(!JSON.stringify(secret).includes('hunter2'));
  const card = describeElement(el({ tag: 'input', type: 'text', autocomplete: 'cc-number', value: '4111 1111' }));
  assert.equal(card.value, undefined);
});

const page = (marks: RawPage['marks'], extra: Partial<RawPage> = {}): RawPage => ({
  url: 'https://shop.test/cart?id=1',
  title: 'Cart',
  scrollX: 0,
  scrollY: 100,
  width: 800,
  height: 600,
  marks,
  ...extra,
});

test('crop geometry: padded union of visible marks, clipped to the viewport, scaled by zoom', () => {
  assert.deepEqual(viewportRect({ scrollX: 10, scrollY: 100 }, { x: 20, y: 150, width: 5, height: 5 }), {
    x: 10,
    y: 50,
    width: 5,
    height: 5,
  });
  const two = page([
    { n: 1, kind: 'element', rect: { x: 100, y: 200, width: 50, height: 20 } },
    { n: 2, kind: 'region', rect: { x: 300, y: 400, width: 100, height: 40 } },
  ]);
  assert.deepEqual(cropRect(two), { x: 100 - CROP_PAD, y: 100 - CROP_PAD, width: 300 + 2 * CROP_PAD, height: 240 + 2 * CROP_PAD });
  assert.deepEqual(cropRect(two, 2, 0), { x: 200, y: 200, width: 600, height: 480 });
  assert.deepEqual(cropRect(two, 0, 0), cropRect(two, 1, 0));
  assert.deepEqual(cropRect(two, Number.NaN, 0), cropRect(two, 1, 0));
  // fractional zoom rounds outward
  assert.deepEqual(cropRect(page([{ n: 1, kind: 'region', rect: { x: 1, y: 101, width: 1, height: 1 } }]), 1.5, 0), {
    x: 1,
    y: 1,
    width: 2,
    height: 2,
  });
  // clipped at the viewport edges; a mark partly outside counts for its visible part
  assert.deepEqual(cropRect(page([{ n: 1, kind: 'region', rect: { x: -40, y: 50, width: 60, height: 900 } }])), {
    x: 0,
    y: 0,
    width: 20 + CROP_PAD,
    height: 600,
  });
  // nothing in view: the whole viewport
  assert.deepEqual(cropRect(page([{ n: 1, kind: 'region', rect: { x: 10, y: 5000, width: 10, height: 10 } }])), {
    x: 0,
    y: 0,
    width: 800,
    height: 600,
  });
  assert.deepEqual(cropRect(page([])), { x: 0, y: 0, width: 800, height: 600 });
});

test('marks are described in order with notes, rounded boxes and visibility', () => {
  const marks = describeMarks(
    page([
      {
        n: 1,
        kind: 'element',
        note: '  make   this bold ',
        rect: { x: 10.4, y: 120.6, width: 30.5, height: 9.49 },
        element: el({ tag: 'h1', text: 'Your cart' }),
      },
      { n: 2, kind: 'region', rect: { x: 0, y: 2000, width: 50, height: 50 }, element: el() },
      { n: 3, kind: 'element', rect: { x: 0, y: 100, width: 5, height: 5 }, element: null },
    ]),
  );
  assert.deepEqual(marks[0], {
    n: 1,
    kind: 'element',
    note: 'make this bold',
    rect: { x: 10, y: 121, width: 31, height: 9 },
    visible: true,
    element: { tag: 'h1', role: 'heading', name: 'Your cart', selector: 'body > div' },
  });
  assert.equal(marks[1].visible, false);
  assert.equal(marks[1].element, undefined);
  assert.equal(marks[2].element, undefined);
});

test('page URLs drop credentials and fragments; unparsable ones are excerpted', () => {
  assert.equal(safeUrl('https://user:pw@x.test/a?b=1#secret'), 'https://x.test/a?b=1');
  assert.equal(safeUrl('not a url'), 'not a url');
});

test('mark text: header, one numbered block per mark, element facts, out-of-screenshot boxes', () => {
  const p = page(
    [
      {
        n: 1,
        kind: 'element',
        note: 'wrong price',
        rect: { x: 10, y: 120, width: 30, height: 10 },
        element: el({
          tag: 'a',
          href: 'https://u:p@shop.test/item#x',
          text: 'Blue mug – $12',
          ariaLabel: 'Item',
          chain: [node('a'), node('li', { nth: 2, ofType: 3 }), node('body')],
        }),
      },
      { n: 2, kind: 'region', rect: { x: 0, y: 3000, width: 50, height: 50 } },
      {
        n: 3,
        kind: 'element',
        rect: { x: 0, y: 100, width: 5, height: 5 },
        element: el({ tag: 'input', type: 'search', value: 'mugs', placeholder: 'Search' }),
      },
      { n: 4, kind: 'element', rect: { x: 0, y: 100, width: 5, height: 5 }, element: el({ tag: 'button', text: 'Buy' }) },
    ],
    { url: 'https://me:pw@shop.test/cart#top', title: '' },
  );
  const text = annotationText(p, describeMarks(p));
  assert.equal(
    text,
    [
      'Browser page annotations: 4 marks on https://shop.test/cart.',
      'The attached screenshot shows the numbered marks; boxes are in page CSS pixels.',
      'Viewport: 800x600, scrolled to (0, 100).',
      '',
      '[1] Element: wrong price',
      '  role: link, name: "Item" <a>',
      '  text: "Blue mug – $12"',
      '  href: https://shop.test/item',
      '  selector: body > li:nth-of-type(2) > a',
      '  box: x=10 y=120 w=30 h=10',
      '',
      '[2] Region',
      '  box: x=0 y=3000 w=50 h=50 (outside the screenshot)',
      '',
      '[3] Element',
      '  role: searchbox, name: "Search" <input>',
      '  value: "mugs"',
      '  selector: body > div',
      '  box: x=0 y=100 w=5 h=5',
      '',
      '[4] Element',
      '  role: button, name: "Buy" <button>',
      '  selector: body > div',
      '  box: x=0 y=100 w=5 h=5',
    ].join('\n'),
  );
  const one = page([{ n: 1, kind: 'region', rect: { x: 0, y: 100, width: 5, height: 5 } }]);
  assert.match(
    annotationText(one, describeMarks(one)),
    /^Browser page annotations: 1 mark on https:\/\/shop\.test\/cart\?id=1 \("Cart"\)\./,
  );
  const noRole = page([{ n: 1, kind: 'element', rect: { x: 0, y: 100, width: 5, height: 5 }, element: el({ tag: 'section' }) }]);
  assert.match(annotationText(noRole, describeMarks(noRole)), /role: region <section>\n/);
});

test('the chip is one image attachment per page carrying its text; send expands it to image + selected context', () => {
  const p = page([{ n: 1, kind: 'region', note: 'here', rect: { x: 0, y: 100, width: 5, height: 5 } }]);
  const chip = pageAnnotationAttachment(p, { path: '/tmp/a.png', previewUrl: 'data:image/png;base64,AA' });
  assert.equal(chip.kind, 'image');
  assert.equal(chip.name, 'Annotations · shop.test');
  assert.equal(chip.pageUrl, 'https://shop.test/cart?id=1');
  assert.match(chip.text!, /\[1\] Region: here/);
  assert.equal(pageAnnotationAttachment({ ...p, url: 'about:blank' }, { path: '/b.png' }).name, 'Annotations · about:blank');
  assert.equal(pageAnnotationAttachment({ ...p, url: 'garbage' }, { path: '/b.png' }).name, 'Annotations · garbage');
  const file = { kind: 'file' as const, path: '/f', name: 'f' };
  const out = expandPageAnnotations([file, chip, { ...chip, text: undefined }]);
  assert.deepEqual(out, [
    file,
    { kind: 'image', path: '/tmp/a.png', name: chip.name, previewUrl: chip.previewUrl },
    { kind: 'selection', path: '', name: chip.name, text: chip.text },
    { kind: 'image', path: '/tmp/a.png', name: chip.name, previewUrl: chip.previewUrl },
    { kind: 'selection', path: '', name: chip.name, text: '' },
  ]);
  // an ordinary pasted image is left alone
  const pasted = { kind: 'image' as const, path: '/p.png', name: 'Pasted image', text: 'x' };
  assert.deepEqual(expandPageAnnotations([pasted]), [pasted]);
});

test('every harness receives the expanded chip through the shared attachment path: image plus mark text', async () => {
  const p = page([
    {
      n: 1,
      kind: 'element',
      note: 'fix spacing',
      rect: { x: 0, y: 100, width: 5, height: 5 },
      element: el({ tag: 'button', text: 'Pay', chain: [node('button'), node('form', { id: 'checkout', idUnique: true })] }),
    },
  ]);
  const chip = pageAnnotationAttachment(p, { path: '/tmp/annot.png' });
  const sent = expandPageAnnotations([chip]);
  // Codex app-server input
  const codex = buildInput('Why is this off?', sent);
  assert.deepEqual(
    codex.find((i: any) => i.type === 'localImage'),
    { type: 'localImage', path: '/tmp/annot.png' },
  );
  const codexText = codex.find((i: any) => i.type === 'text').text;
  assert.match(codexText, /\[1\] Element: fix spacing/);
  assert.match(codexText, /selector: #checkout > button/);
  assert.match(codexText, /## My request:\nWhy is this off\?/);
  // Claude Code message
  const claude = buildClaudeMessage({ text: 'Why is this off?', attachments: sent }, (file: string) => ({
    type: 'base64',
    media_type: 'image/png',
    data: file,
  }));
  assert.deepEqual(claude.content[0], { type: 'image', source: { type: 'base64', media_type: 'image/png', data: '/tmp/annot.png' } });
  assert.equal(claude.content[1].text, codexText);
  // ACP prompt blocks
  const acp = await acpBlocks('Why is this off?', sent, async () => 'data:image/png;base64,QUJD');
  assert.equal(acp[0].text, codexText);
  assert.deepEqual(acp[1], { type: 'image', mimeType: 'image/png', data: 'QUJD' });
});

/* ------------------------------------------------------------------ */
/* the in-page overlay                                                 */
/* ------------------------------------------------------------------ */
const windows: Window[] = [];
after(() => {
  for (const w of windows) w.happyDOM.abort();
});

function pageWindow() {
  const win = new Window({ url: 'https://shop.test/cart', width: 800, height: 600 }) as any;
  windows.push(win);
  const doc = win.document;
  doc.title = 'Cart';
  doc.body.innerHTML = `
    <main id="main">
      <h1 data-testid="title">Your cart</h1>
      <form id="login"><label for="pw">Password</label><input id="pw" type="password" value="hunter2"><input id="mail" value="me@x.test" autocomplete="email"></form>
      <a href="/item">Mug</a><a>Plain</a>
      <div aria-labelledby="missing ttl" id="dup"></div><div id="dup"></div>
      <span id="ttl">Title</span><select id="size"><option value="m" selected>M</option></select>
      <svg id="icon"><circle></circle></svg>
      <input type="hidden" id="token" value="csrf-secret"><p id="empty"></p>
    </main>`;
  const signals: string[] = [];
  win.console.debug = (m: string) => signals.push(m);
  // the overlay's shadow root is closed: keep a handle for the test
  const roots: any[] = [];
  const attach = win.HTMLElement.prototype.attachShadow;
  win.HTMLElement.prototype.attachShadow = function (this: any, init: any) {
    const r = attach.call(this, { ...init, mode: 'open' });
    roots.push(r);
    return r;
  };
  const rects = new Map<any, any>();
  const rect = (target: any, x: number, y: number, width: number, height: number) => {
    rects.set(target, { left: x, top: y, width, height, right: x + width, bottom: y + height });
    target.getBoundingClientRect = () => rects.get(target);
  };
  let under: any = null;
  doc.elementFromPoint = () => under;
  win.requestAnimationFrame = (fn: Function) => setTimeout(fn, 0);
  const point = (target: any) => {
    under = target;
  };
  return { win, doc, signals, roots, rect, point };
}

function pointer(target: any, type: string, init: any = {}) {
  const e = new target.ownerDocument.defaultView.PointerEvent(type, {
    bubbles: true,
    cancelable: true,
    composed: true,
    button: 0,
    ...init,
  });
  target.dispatchEvent(e);
  return e;
}

const lastMarks = (signals: string[], prefix: string) => {
  const line = signals.filter((s) => s.startsWith(`${prefix}{"type":"marks"`)).at(-1)!;
  return JSON.parse(line.slice(prefix.length)).marks;
};

test('every click and drag adds a mark (no Shift): earlier marks stay, numbered in order; no click reaches the page', async () => {
  const { win, doc, signals, roots, rect, point } = pageWindow();
  const h1 = doc.querySelector('h1');
  const link = doc.querySelector('a[href]');
  rect(h1, 10, 20, 200, 30);
  rect(link, 10, 80, 40, 16);
  let pageClicks = 0;
  doc.body.addEventListener('click', () => pageClicks++);
  doc.body.addEventListener('mousedown', () => pageClicks++);
  const focused = doc.getElementById('mail');
  focused.focus();
  assert.equal(annotateOverlay(win, { key: ANNOTATE_KEY, signal: 'S:' }), true);
  assert.notEqual(doc.activeElement, focused);
  assert.deepEqual(signals, ['S:{"type":"marks","marks":[]}']);
  const host = doc.documentElement.lastElementChild;
  assert.equal(host.tagName, 'MOPILOT-ANNOTATE');
  const layer = roots[0].firstElementChild;
  const [hover, dragBox] = layer.children;
  // hover highlights the element under the pointer
  point(h1);
  pointer(layer, 'pointermove', { clientX: 15, clientY: 25 });
  assert.equal(hover.style.getPropertyValue('display'), 'block');
  assert.equal(hover.style.getPropertyValue('width'), '200px');
  point(doc.body);
  pointer(layer, 'pointermove', { clientX: 1, clientY: 1 });
  assert.equal(hover.style.getPropertyValue('display'), 'none');
  point(h1);
  pointer(layer, 'pointermove', { clientX: 15, clientY: 25 });
  pointer(layer, 'pointerleave');
  assert.equal(hover.style.getPropertyValue('display'), 'none');
  // a click marks the element; the mouse family is swallowed
  pointer(layer, 'pointerdown', { clientX: 15, clientY: 25 });
  pointer(layer, 'pointermove', { clientX: 16, clientY: 26 });
  pointer(layer, 'pointerup', { clientX: 16, clientY: 26 });
  for (const type of ['mousedown', 'mouseup', 'click', 'dblclick', 'auxclick', 'contextmenu']) {
    const e = new win.MouseEvent(type, { bubbles: true, cancelable: true, composed: true });
    layer.dispatchEvent(e);
    assert.equal(e.defaultPrevented, true, type);
  }
  assert.equal(pageClicks, 0);
  assert.deepEqual(lastMarks(signals, 'S:'), [{ id: 1, n: 1, kind: 'element', label: 'h1' }]);
  // IAB-12: a plain click on another element adds to the marks, it does not replace them
  point(link);
  pointer(layer, 'pointerdown', { clientX: 12, clientY: 85 });
  pointer(layer, 'pointerup', { clientX: 12, clientY: 85 });
  assert.equal(win[ANNOTATE_KEY].count(), 2);
  // a plain drag adds a region, and the marks made before it stay
  pointer(layer, 'pointerdown', { clientX: 300, clientY: 300 });
  pointer(layer, 'pointermove', { clientX: 320, clientY: 330 });
  assert.equal(dragBox.style.getPropertyValue('display'), 'block');
  assert.equal(hover.style.getPropertyValue('display'), 'none');
  pointer(layer, 'pointermove', { clientX: 280, clientY: 260 });
  pointer(layer, 'pointerup', { clientX: 280, clientY: 260 });
  assert.equal(dragBox.style.getPropertyValue('display'), 'none');
  assert.deepEqual(lastMarks(signals, 'S:'), [
    { id: 1, n: 1, kind: 'element', label: 'h1' },
    { id: 2, n: 2, kind: 'element', label: 'a' },
    { id: 3, n: 3, kind: 'region', label: 'region' },
  ]);
  // empty space, the right button and a stray pointerup add nothing
  point(null);
  pointer(layer, 'pointerdown', { clientX: 700, clientY: 500 });
  pointer(layer, 'pointerup', { clientX: 700, clientY: 500 });
  pointer(layer, 'pointerdown', { button: 2 });
  pointer(layer, 'pointerup');
  assert.equal(win[ANNOTATE_KEY].count(), 3);
  const boxes = () => [...layer.children].slice(2);
  assert.deepEqual(
    boxes().map((b: any) => b.children[0].textContent),
    ['1', '2', '3'],
  );
  assert.deepEqual(
    boxes().map((b: any) => b.children[1].textContent),
    ['×', '×', '×'],
  );
  // the boxes hold numbers and controls only: no input and no text of the user's
  assert.equal(layer.querySelector('input'), null);
  // a click on a mark's number selects it (thicker outline) and tells the pane; it adds no mark
  const badge = boxes()[1].children[0];
  point(link);
  pointer(badge, 'pointermove', { clientX: 12, clientY: 85 });
  assert.equal(hover.style.getPropertyValue('display'), 'none', 'no hover box over a mark control');
  pointer(badge, 'pointerdown', { clientX: 12, clientY: 85 });
  pointer(badge, 'pointerup', { clientX: 12, clientY: 85 });
  assert.equal(signals.at(-1), 'S:{"type":"select","id":2}');
  assert.equal(win[ANNOTATE_KEY].count(), 3);
  assert.deepEqual(
    boxes().map((b: any) => b.style.getPropertyValue('outline-width')),
    ['2px', '3px', '2px'],
  );
  // a drag that starts on a number still marks a region
  pointer(badge, 'pointerdown', { clientX: 12, clientY: 85 });
  pointer(layer, 'pointermove', { clientX: 60, clientY: 120 });
  pointer(layer, 'pointerup', { clientX: 60, clientY: 120 });
  assert.equal(win[ANNOTATE_KEY].count(), 4);
  // × removes its mark and renumbers the rest; the selection goes with a removed mark
  pointer(boxes()[3].children[1], 'pointerdown');
  pointer(boxes()[3].children[1], 'pointerup');
  pointer(boxes()[1].children[1], 'pointerdown');
  pointer(boxes()[1].children[1], 'pointerup');
  assert.deepEqual(lastMarks(signals, 'S:'), [
    { id: 1, n: 1, kind: 'element', label: 'h1' },
    { id: 3, n: 2, kind: 'region', label: 'region' },
  ]);
  assert.deepEqual(
    boxes().map((b: any) => [b.children[0].textContent, b.style.getPropertyValue('outline-width')]),
    [
      ['1', '2px'],
      ['2', '2px'],
    ],
  );
  // the controller: select and remove by id; unknown ids do nothing
  assert.equal(win[ANNOTATE_KEY].select(3), true);
  assert.equal(win[ANNOTATE_KEY].select(2), false);
  assert.equal(win[ANNOTATE_KEY].remove(2), false);
  win[ANNOTATE_KEY].select(1);
  assert.equal(win[ANNOTATE_KEY].remove(3), true);
  assert.deepEqual(
    boxes().map((b: any) => b.style.getPropertyValue('outline-width')),
    ['3px'],
  );
  win[ANNOTATE_KEY].remove(1);
  assert.equal(win[ANNOTATE_KEY].count(), 0);
  // mark again: scrolling moves the boxes with the page; a removed element keeps its last box
  point(link);
  pointer(layer, 'pointerdown', { clientX: 12, clientY: 85 });
  pointer(layer, 'pointerup', { clientX: 12, clientY: 85 });
  point(h1);
  pointer(layer, 'pointerdown', { clientX: 15, clientY: 25 });
  pointer(layer, 'pointerup', { clientX: 15, clientY: 25 });
  pointer(layer, 'pointerdown', { clientX: 300, clientY: 300 });
  pointer(layer, 'pointermove', { clientX: 340, clientY: 320 });
  pointer(layer, 'pointerup', { clientX: 340, clientY: 320 });
  link.remove();
  win.dispatchEvent(new win.Event('scroll'));
  win.dispatchEvent(new win.Event('resize'));
  const collected = win[ANNOTATE_KEY].collect();
  assert.equal(collected.url, 'https://shop.test/cart');
  assert.equal(collected.title, 'Cart');
  // ids keep counting; the page holds no notes
  assert.deepEqual(
    collected.marks.map((m: any) => [m.id, m.n, m.kind, 'note' in m]),
    [
      [5, 1, 'element', false],
      [6, 2, 'element', false],
      [7, 3, 'region', false],
    ],
  );
  assert.equal(collected.marks[2].element, null);
  assert.deepEqual(collected.marks[0].rect, { x: 10, y: 80, width: 40, height: 16 });
  assert.deepEqual(collected.marks[1].element.chain[0], {
    tag: 'h1',
    id: undefined,
    idUnique: undefined,
    testId: 'title',
    testIdUnique: true,
    nth: 1,
    ofType: 1,
  });
  assert.equal(collected.marks[1].element.text, 'Your cart');
  // capture mode hides the hover box, the × controls and the selection until switched off
  win[ANNOTATE_KEY].select(6);
  pointer(layer, 'pointermove', { clientX: 15, clientY: 25 });
  assert.equal(await win[ANNOTATE_KEY].capture(true), true);
  assert.equal(hover.style.getPropertyValue('display'), 'none');
  assert.deepEqual(
    boxes().map((b: any) => [b.children[1].style.getPropertyValue('display'), b.style.getPropertyValue('outline-width')]),
    [
      ['none', '2px'],
      ['none', '2px'],
      ['none', '2px'],
    ],
  );
  await win[ANNOTATE_KEY].capture(false);
  assert.deepEqual(
    boxes().map((b: any) => [b.children[1].style.getPropertyValue('display'), b.style.getPropertyValue('outline-width')]),
    [
      ['block', '2px'],
      ['block', '3px'],
      ['block', '2px'],
    ],
  );
  // clear, then destroy: the page is back as it was
  win[ANNOTATE_KEY].clear();
  assert.equal(win[ANNOTATE_KEY].count(), 0);
  assert.equal(signals.at(-1), 'S:{"type":"marks","marks":[]}');
  win[ANNOTATE_KEY].destroy();
  assert.equal(win[ANNOTATE_KEY], undefined);
  assert.equal(doc.querySelector('mopilot-annotate'), null);
  pointer(layer, 'pointerdown', { clientX: 15, clientY: 25 });
  win.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'Escape' }));
  assert.equal(signals.at(-1), 'S:{"type":"marks","marks":[]}');
});

test('keys: Escape anywhere in the page asks the pane to leave; other keys are left alone', () => {
  const { win, signals } = pageWindow();
  annotateOverlay(win, { key: ANNOTATE_KEY, signal: 'K:' });
  const key = (k: string, type = 'keydown') => {
    const e = new win.KeyboardEvent(type, { key: k, bubbles: true, cancelable: true });
    win.dispatchEvent(e);
    return e;
  };
  assert.equal(key('a').defaultPrevented, false);
  key('Escape', 'keyup');
  key('Enter');
  assert.ok(!signals.includes('K:{"type":"exit"}'));
  assert.equal(key('Escape').defaultPrevented, true);
  assert.equal(signals.at(-1), 'K:{"type":"exit"}');
  win[ANNOTATE_KEY].destroy();
});

test('element facts: labels, links, values, and never a password or hidden value', () => {
  const { win, doc, roots, rect, point } = pageWindow();
  annotateOverlay(win, { key: ANNOTATE_KEY, signal: 'E:' });
  const layer = roots[0].firstElementChild;
  const mark = (target: any) => {
    rect(target, 0, 0, 10, 10);
    point(target);
    pointer(layer, 'pointerdown');
    pointer(layer, 'pointerup');
  };
  const ids = ['pw', 'mail', 'dup', 'size', 'icon', 'token', 'empty'];
  for (const id of ids) mark(doc.getElementById(id));
  mark(doc.querySelector('a[href]'));
  mark(doc.querySelector('a:not([href])'));
  const out = win[ANNOTATE_KEY].collect().marks.map((m: any) => m.element);
  const [pw, mail, dup, size, icon, token, empty, link, plain] = out;
  assert.equal(JSON.stringify(out).includes('hunter2'), false);
  assert.equal(JSON.stringify(out).includes('csrf-secret'), false);
  assert.deepEqual([pw.type, pw.value, pw.text, pw.label], ['password', undefined, undefined, 'Password']);
  assert.deepEqual([token.type, token.value], ['hidden', undefined]);
  assert.deepEqual([mail.type, mail.value, mail.autocomplete, mail.text], ['text', 'me@x.test', 'email', undefined]);
  assert.equal(mail.chain[0].idUnique, true);
  assert.deepEqual([dup.labelledBy, dup.chain[0].idUnique, dup.chain[0].nth, dup.chain[0].ofType], ['Title', false, 1, 2]);
  assert.equal(size.value, 'm');
  assert.equal(icon.tag, 'svg');
  assert.equal(empty.text, '');
  assert.equal(empty.label, undefined);
  assert.equal(link.href, 'https://shop.test/item');
  assert.equal(plain.href, undefined);
  assert.equal(link.chain.at(-1).tag, 'html');
  // a second install replaces the first
  annotateOverlay(win, { key: ANNOTATE_KEY, signal: 'E:' });
  assert.equal(doc.querySelectorAll('mopilot-annotate').length, 1);
  assert.equal(win[ANNOTATE_KEY].count(), 0);
  win[ANNOTATE_KEY].destroy();
});

test('page scripts install a self-contained overlay from source and drive it; signals parse strictly', async () => {
  const { win, doc, rect, point, roots, signals } = pageWindow();
  const exec = (script: string) => new Function('window', `return ${script}`)(win);
  assert.equal(exec(annotateScripts.collect()), null);
  assert.equal(exec(annotateScripts.install('P:')), true);
  rect(doc.querySelector('h1'), 0, 0, 5, 5);
  point(doc.querySelector('h1'));
  assert.equal(exec(annotateScripts.collect()).marks.length, 0);
  const layer = roots[0].firstElementChild;
  pointer(layer, 'pointerdown');
  pointer(layer, 'pointerup');
  assert.equal(exec(annotateScripts.select(1)), true);
  assert.equal(exec(annotateScripts.select(1.5)), false, 'a non-integer id is no id');
  assert.equal(exec(annotateScripts.unmark(1)), true);
  assert.equal(exec(annotateScripts.unmark(1)), false);
  assert.equal(await exec(annotateScripts.capture(true)), true);
  await exec(annotateScripts.capture(false));
  exec(annotateScripts.clear());
  exec(annotateScripts.destroy());
  assert.equal(doc.querySelector('mopilot-annotate'), null);
  assert.equal(exec(annotateScripts.destroy()), null);
  assert.ok(signals.length > 0);
  assert.equal(readSignal('P:{"type":"exit"}', 'P:')?.type, 'exit');
  assert.deepEqual(readSignal('P:{"type":"select","id":3}', 'P:'), { type: 'select', id: 3 });
  const marks = [
    { id: 4, n: 1, kind: 'element', label: 'x'.repeat(60) },
    { id: 9, n: 2, kind: 'region', label: 'region' },
  ];
  assert.deepEqual(readSignal(`P:${JSON.stringify({ type: 'marks', marks })}`, 'P:'), {
    type: 'marks',
    marks: [{ ...marks[0], label: 'x'.repeat(40) }, marks[1]],
  });
  assert.deepEqual(readSignal('P:{"type":"marks","marks":[]}', 'P:'), { type: 'marks', marks: [] });
  const bad = [
    'P:{"type":"select","id":0}',
    'P:{"type":"select","id":"1"}',
    'P:{"type":"marks","marks":{}}',
    'P:{"type":"marks","marks":[null]}',
    'P:{"type":"marks","marks":[{"id":1,"n":0,"kind":"region","label":""}]}',
    'P:{"type":"marks","marks":[{"id":1,"n":1,"kind":"other","label":""}]}',
    'P:{"type":"marks","marks":[{"id":1,"n":1,"kind":"region"}]}',
    'P:{"type":"marks","marks":[{"id":-1,"n":1,"kind":"region","label":""}]}',
    'P:{"type":"count","count":3}',
    'P:{"type":"other"}',
    'P:null',
    'P:{',
    'Q:{"type":"exit"}',
  ];
  for (const b of bad) assert.equal(readSignal(b, 'P:'), null, b);
  assert.equal(readSignal(42, 'P:'), null);
});

/* ------------------------------------------------------------------ */
/* main: the isolated Annotate world and the marked screenshot          */
/* ------------------------------------------------------------------ */
test('capture rects are whole positive DIPs within bounds', () => {
  assert.deepEqual(captureRect({ x: -3.2, y: 1.6, width: 10.4, height: 20.5 }), { x: 0, y: 2, width: 10, height: 21 });
  assert.deepEqual(captureRect({ x: 0, y: 0, width: 1e9, height: 5 }), { x: 0, y: 0, width: MAX_SIDE, height: 5 });
  for (const bad of [
    null,
    {},
    { x: 0, y: 0, width: 0, height: 5 },
    { x: 0, y: 0, width: 5, height: -1 },
    { x: '1', y: 0, width: 5, height: 5 },
    { x: 0, y: Infinity, width: 5, height: 5 },
  ])
    assert.equal(captureRect(bad), null);
});

const paneTabOf = (sender: any, session: any, extra: any = {}) => ({
  isDestroyed: () => false,
  getType: () => 'webview',
  hostWebContents: sender,
  session,
  ...extra,
});

test('a pane tab is a live <webview> guest of the asking window, in any of the pane sessions', () => {
  const sender = {};
  const shared = {};
  const chat = {};
  assert.equal(isPaneTab(paneTabOf(sender, shared), { sender, panelSession: shared }), true);
  // a chat's own partition (Settings → Browser → Storage) is a pane session too
  assert.equal(isPaneTab(paneTabOf(sender, chat), { sender, panelSession: [shared, chat] }), true);
  assert.equal(isPaneTab(paneTabOf(sender, {}), { sender, panelSession: [shared, chat] }), false);
  assert.equal(isPaneTab(null, { sender, panelSession: shared }), false);
  assert.equal(isPaneTab(paneTabOf(sender, shared, { isDestroyed: () => true }), { sender, panelSession: shared }), false);
  assert.equal(isPaneTab(paneTabOf(sender, shared, { getType: () => 'window' }), { sender, panelSession: shared }), false);
  assert.equal(isPaneTab(paneTabOf({}, shared), { sender, panelSession: shared }), false);
});

test('main captures only a painted pane tab of the asking window, as a PNG data URL', async () => {
  const sender = {};
  const panelSession = {};
  const image = (empty = false) => ({ isEmpty: () => empty, toDataURL: () => 'data:image/png;base64,QQ==' });
  const tab = (extra: any = {}) =>
    paneTabOf(sender, panelSession, {
      capturePage: async (r: any) => {
        tab.last = r;
        return image();
      },
      ...extra,
    });
  tab.last = null as any;
  const ctx = { sender, panelSession };
  assert.equal(await captureRegion(tab(), { x: 1, y: 2, width: 3, height: 4 }, ctx), 'data:image/png;base64,QQ==');
  assert.deepEqual(tab.last, { x: 1, y: 2, width: 3, height: 4 });
  const rect = { x: 0, y: 0, width: 5, height: 5 };
  assert.equal(await captureRegion(tab(), null, ctx), null);
  assert.equal(await captureRegion(null, rect, ctx), null);
  assert.equal(await captureRegion(tab({ session: {} }), rect, ctx), null);
  assert.equal(await captureRegion(tab({ capturePage: async () => image(true) }), rect, ctx), null);
  assert.equal(await captureRegion(tab({ capturePage: async () => null }), rect, ctx), null);
  assert.equal(
    await captureRegion(
      tab({
        capturePage: async () => {
          throw new Error('gone');
        },
      }),
      rect,
      ctx,
    ),
    null,
  );
  assert.equal(await captureRegion(tab({ capturePage: () => new Promise(() => {}) }), rect, { ...ctx, timeoutMs: 5 }), null);
});

test('IAB-13: overlay scripts run only in the isolated Annotate world of a pane tab, never in the page world', async () => {
  const sender = {};
  const panelSession = {};
  const calls: any[] = [];
  const tab = (extra: any = {}) =>
    paneTabOf(sender, panelSession, {
      executeJavaScript: (...a: any[]) => {
        calls.push(['main', ...a]);
        return Promise.resolve('main world');
      },
      executeJavaScriptInIsolatedWorld: (...a: any[]) => {
        calls.push(['isolated', ...a]);
        return Promise.resolve({ ok: 1 });
      },
      ...extra,
    });
  const ctx = { sender, panelSession: [panelSession] };
  assert.deepEqual(await runOverlay(tab(), annotateScripts.collect(), ctx), { ok: 1 });
  assert.deepEqual(calls, [['isolated', ANNOTATE_WORLD, [{ code: annotateScripts.collect() }]]]);
  // a world of its own: not the page's (0) and not Electron's preload world (999)
  assert.ok(ANNOTATE_WORLD !== 0 && ANNOTATE_WORLD !== 999 && Number.isInteger(ANNOTATE_WORLD));
  for (const code of [42, '', 'x'.repeat(MAX_SCRIPT + 1), null])
    await assert.rejects(runOverlay(tab(), code, ctx), /Not an Annotate script/);
  await assert.rejects(runOverlay(tab({ session: {} }), 'true', ctx), /Not a browser pane tab/);
  await assert.rejects(runOverlay(tab({ hostWebContents: {} }), 'true', ctx), /Not a browser pane tab/);
  await assert.rejects(runOverlay(null, 'true', ctx), /Not a browser pane tab/);
  assert.equal(calls.filter((c) => c[0] === 'main').length, 0, 'nothing ever runs in the page world');
});

test('the IPC looks the tab up by id, in every pane session, and refuses ids that are not webContents', async () => {
  const handlers = new Map<string, Function>();
  const sender = {};
  const shared = {};
  const chat = {};
  const ran: any[] = [];
  const tab = paneTabOf(sender, chat, {
    capturePage: async () => ({ isEmpty: () => false, toDataURL: () => 'data:image/png;base64,Qg==' }),
    executeJavaScriptInIsolatedWorld: async (world: number, scripts: any[]) => {
      ran.push([world, scripts]);
      return true;
    },
  });
  const webContents = {
    fromId: (id: any) => {
      if (typeof id !== 'number') throw new TypeError('bad id');
      return id === 7 ? tab : undefined;
    },
  };
  registerCapture({ handle: (name: string, fn: Function) => handlers.set(name, fn) }, { webContents, panelSession: () => [shared, chat] });
  const capture = handlers.get('browser:captureRegion')!;
  const rect = { x: 0, y: 0, width: 4, height: 4 };
  assert.equal(await capture({ sender }, 7, rect), 'data:image/png;base64,Qg==');
  assert.equal(await capture({ sender }, 8, rect), null);
  assert.equal(await capture({ sender }, 'x', rect), null);
  assert.equal(await capture({ sender: {} }, 7, rect), null);
  const annotate = handlers.get('browser:annotate')!;
  assert.equal(await annotate({ sender }, 7, 'true'), true);
  assert.deepEqual(ran, [[ANNOTATE_WORLD, [{ code: 'true' }]]]);
  await assert.rejects(annotate({ sender }, 'x', 'true'), /Not a browser pane tab/);
  await assert.rejects(annotate({ sender: {} }, 7, 'true'), /Not a browser pane tab/);
});
