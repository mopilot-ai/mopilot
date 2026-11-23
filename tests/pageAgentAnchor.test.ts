// Action memory's anchors in the page agent (#3571, G4; electron/capabilities/browser/pageAgentAnchor.cjs): a ref or a
// point becomes locator steps that the query op resolves again to the same element, by role and name, under a container
// when twins share them, by index as a last resort, through same-origin frames, and never for a cross-origin point.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { doc, define, agent, load, frameDoc, refAt, run } from './support/page-agent/fixture.ts';

const { anchorKit } = createRequire(import.meta.url)('../electron/capabilities/browser/pageAgentAnchor.cjs');

const tree = () => run('tree', { filter: 'all' }).lines as string[];
/** The steps resolve to the ref's element alone. */
const resolvesTo = (steps: any[], ref: string) => {
  const q = run('query', { steps });
  assert.equal(q.count, 1, JSON.stringify(steps));
  assert.equal(agent.element(q.refs[0]), agent.element(ref));
};

test('anchor: a unique control is its role and exact name', () => {
  load('<button id=go>Search</button><a href=/x>Search help</a>');
  const ref = refAt(tree(), 'button "Search"');
  const a = run('anchor', { ref });
  assert.deepEqual(a, { steps: [{ k: 'role', role: 'button', name: { s: 'Search', exact: true } }], weak: false, secret: false });
  resolvesTo(a.steps, ref);
});

test('anchor: twins are told apart by their named container, else by the start of its text', () => {
  load(`<section aria-label="Cart"><button>Delete</button></section><section aria-label="Saved"><button>Delete</button></section>
    <ul><li>Apples <button>Remove</button></li><li>Pears <button>Remove</button></li></ul>`);
  const lines = tree();
  const saved = lines.filter((l) => l.includes('button "Delete"'))[1].match(/\[(ref_\d+)\]/)![1];
  const a = run('anchor', { ref: saved });
  assert.deepEqual(a.steps[0], { k: 'role', role: 'region', name: { s: 'Saved', exact: true } });
  assert.equal(a.weak, false);
  resolvesTo(a.steps, saved);
  const pears = lines.filter((l) => l.includes('button "Remove"'))[1].match(/\[(ref_\d+)\]/)![1];
  const b = run('anchor', { ref: pears });
  assert.deepEqual(b.steps.slice(0, 2), [
    { k: 'role', role: 'listitem' },
    { k: 'filter', hasText: { s: 'Pears Remove' } },
  ]);
  resolvesTo(b.steps, pears);
});

test('anchor: twins no container tells apart keep their index, marked weak', () => {
  load('<div><button>More</button><button>More</button></div>');
  const second = tree()
    .filter((l) => l.includes('button "More"'))[1]
    .match(/\[(ref_\d+)\]/)![1];
  const a = run('anchor', { ref: second });
  assert.deepEqual(a.steps, [
    { k: 'role', role: 'button', name: { s: 'More', exact: true } },
    { k: 'nth', i: 1 },
  ]);
  assert.equal(a.weak, true);
  resolvesTo(a.steps, second);
});

test('anchor: an unnamed role matches by role alone; a role-less element by its text; nothing to say is null', () => {
  const $ = load('<input id=q><span id=s>Plain words</span><div id=empty></div>');
  const q = run('anchor', { ref: agent.refFor($('q')).ref });
  assert.deepEqual(q.steps, [{ k: 'role', role: 'textbox' }]);
  const s = run('anchor', { ref: agent.refFor($('s')).ref });
  assert.deepEqual(s.steps, [{ k: 'text', m: { s: 'Plain words', exact: true } }]);
  assert.equal(run('anchor', { ref: agent.refFor($('empty')).ref }), null);
  assert.equal(run('anchor', { ref: 'ref_999999' }), null, 'a stale ref');
  assert.equal(run('anchor', {}), null, 'neither a ref nor a point');
});

test('anchor: a password field is marked secret', () => {
  const $ = load('<label>Password <input id=p type=password></label>');
  const a = run('anchor', { ref: agent.refFor($('p')).ref });
  assert.equal(a.secret, true);
});

test('anchor: a point anchors the control under it (a label names its field); a cross-origin frame is not anchored', () => {
  const $ = load('<label id=l for=n>Name</label><input id=n><button id=b><span id=inner>Send</span></button><iframe id=f></iframe>');
  const at = (el: any) => define(doc, 'elementFromPoint', { value: () => el });
  try {
    at($('inner'));
    assert.deepEqual(run('anchor', { x: 1, y: 1 }).steps, [{ k: 'role', role: 'button', name: { s: 'Send', exact: true } }]);
    at($('l'));
    assert.deepEqual(run('anchor', { x: 1, y: 1 }).steps, [{ k: 'role', role: 'textbox', name: { s: 'Name', exact: true } }]);
    at(null);
    assert.equal(run('anchor', { x: 1, y: 1 }), null);
    define($('f'), 'contentDocument', {
      get: () => {
        throw Object.assign(new Error('blocked'), { name: 'SecurityError' });
      },
    });
    at($('f'));
    assert.deepEqual(run('anchor', { x: 1, y: 1 }), { frame: true });
  } finally {
    delete doc.elementFromPoint;
  }
});

test('anchor: a control in a same-origin frame is reached through the frame element, then a frame step', () => {
  const $ = load('<iframe id=f title="Checkout"></iframe>');
  const inner = frameDoc($('f'), '<button id=pay>Pay now</button>');
  // happy-dom leaves a frame's frameElement unset
  define(inner.defaultView, 'frameElement', { value: $('f') });
  const ref = agent.refFor(inner.getElementById('pay')).ref;
  const a = run('anchor', { ref });
  assert.deepEqual(a.steps, [
    { k: 'role', role: 'iframe', name: { s: 'Checkout', exact: true } },
    { k: 'frame' },
    { k: 'role', role: 'button', name: { s: 'Pay now', exact: true } },
  ]);
  resolvesTo(a.steps, ref);
});

test('anchor kit: an element of an unreadable frame chain, or one with no readable twin list, is not anchored', () => {
  const el: any = { ownerDocument: { defaultView: {} }, textContent: 'x' };
  const kit = anchorKit({
    roleOf: () => 'button',
    styleOf: () => null,
    nameOf: () => 'Go',
    clean: (s: unknown) => String(s ?? ''),
    run: () => [el],
    deref: () => Object.assign(el, { nodeType: 1 }),
    atPoint: () => null,
    frameOf: () => null,
    isSecret: () => false,
  });
  // the element's document is not this world's top one, and its frame element can't be read
  assert.equal(kit.anchor({ ref: 'ref_1' }), null);
  const lost = anchorKit({
    roleOf: () => 'button',
    styleOf: () => null,
    nameOf: () => 'Go',
    clean: (s: unknown) => String(s ?? ''),
    run: () => [],
    deref: () => ({ nodeType: 1, ownerDocument: {}, parentNode: null }),
    atPoint: () => null,
    frameOf: () => null,
    isSecret: () => false,
  });
  assert.equal(lost.anchor({ ref: 'ref_1' }), null, 'its own step does not find it');
});

test('anchor: a container is found across an open shadow root; empty containers fall back to the index; a plain point is its text', () => {
  const $ = load(
    '<section aria-label="Left"><div id=host></div></section><section aria-label="Right"><button>Go</button></section><ul><li><input></li><li><input id=second></li></ul><span id=plain>Just text</span>',
  );
  const root = $('host').attachShadow({ mode: 'open' });
  root.innerHTML = '<button id=inner>Go</button>';
  const inner = agent.refFor(root.getElementById('inner')).ref;
  const a = run('anchor', { ref: inner });
  assert.deepEqual(a.steps[0], { k: 'role', role: 'region', name: { s: 'Left', exact: true } });
  resolvesTo(a.steps, inner);
  // list items with no text can't tell two empty fields apart: the index does
  const second = agent.refFor($('second')).ref;
  const b = run('anchor', { ref: second });
  assert.equal(b.weak, true);
  assert.deepEqual(b.steps.at(-1), { k: 'nth', i: 1 });
  define(doc, 'elementFromPoint', { value: () => $('plain') });
  try {
    assert.deepEqual(run('anchor', { x: 1, y: 2 }).steps, [{ k: 'text', m: { s: 'Just text', exact: true } }]);
  } finally {
    delete doc.elementFromPoint;
  }
});
