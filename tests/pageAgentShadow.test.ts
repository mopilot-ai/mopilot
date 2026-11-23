// The page agent's closed shadow roots and re-rendered refs (#3571, G9; electron/capabilities/browser/pageAgentShadow.cjs):
// hosts main may know a closed root of are flagged and offered once, a handed-over root is walked, hit-tested and
// focused like an open one, and a ref whose element was replaced moves only to its one same tag, role and name twin.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { win, doc, define, box, agent, load, frameDoc, refAt, shape } from './support/page-agent/fixture.ts';
import { supportDefined } from './support/page-agent/defined.ts';

const { shadowKit } = createRequire(import.meta.url)('../electron/capabilities/browser/pageAgentShadow.cjs');

const call = (op: string, args?: any) => agent.call(op, args);
/** Defines custom elements in a window, so its elements of those names are upgraded (:defined), as a page's would be. */
const upgrade = (w: any, ...tags: string[]) => {
  for (const tag of tags) if (!w.customElements.get(tag)) w.customElements.define(tag, class extends w.HTMLElement {});
};
supportDefined(win);
upgrade(win, 'x-card', 'plain-div', 'x-pane', 'q-x', 'late-card', 'odd-card');

test('closed roots: a custom element with no root it can see is flagged, offered once, and its handed-over root is read', () => {
  const $ = load('<x-card id=card></x-card><plain-div id=plain><b>light</b></plain-div><div id=nodash></div>');
  const root = $('card').attachShadow({ mode: 'closed' });
  root.innerHTML = '<button id=inner>Closed shadow button</button>';
  // the walk passed hosts main may know more about
  const first = call('tree', { filter: 'all' });
  assert.equal(first.closedRoots, true);
  assert.deepEqual(shape(first.value.lines), ['- text "light"']);
  // each is offered once; an element without a hyphen never is
  assert.deepEqual(agent.closedHosts(), [$('card'), $('plain')]);
  assert.deepEqual(agent.closedHosts(), []);
  assert.equal(call('tree', { filter: 'all' }).closedRoots, undefined, 'offered hosts are not flagged again');
  // only the host's own root is taken
  const other = doc.createElement('y-other').attachShadow({ mode: 'open' });
  assert.equal(agent.adopt($('card'), other), false);
  assert.equal(agent.adopt(null, root), false);
  assert.equal(agent.adopt($('card'), root), true);
  const open = doc.createElement('z-open');
  const openRoot = open.attachShadow({ mode: 'open' });
  assert.equal(agent.adopt(open, openRoot), false, 'an open root needs no hand-over');
  assert.deepEqual(shape(call('tree', { filter: 'all' }).value.lines), ['- button "Closed shadow button" [ref]', '- text "light"']);
  // find and locators reach into it too
  assert.equal(call('find', { query: 'Closed shadow' }).value.lines.length, 1);
});

test('closed roots: hit tests and focus go through a handed-over root', () => {
  const $ = load('<x-pane id=pane></x-pane><div id=over>Overlay</div>');
  const root = $('pane').attachShadow({ mode: 'closed' });
  root.innerHTML = '<button id=deep>Deep</button>';
  agent.closedHosts();
  assert.equal(agent.adopt($('pane'), root), true);
  const deep = box(root.getElementById('deep'), 10, 10, 40, 20);
  const ref = agent.refFor(deep).ref;
  define(doc, 'elementFromPoint', { value: () => $('pane') });
  define(root, 'elementFromPoint', { value: () => deep });
  try {
    // the host is not a cover of what its closed root shows
    assert.equal(call('locate', { ref, hit: true }).value.cover, null);
    assert.equal(call('intent', { x: 30, y: 20 }).value.name, 'Deep');
    define(doc, 'activeElement', { value: $('pane') });
    define(root, 'activeElement', { value: deep });
    assert.equal(call('intent', {}).value.name, 'Deep');
  } finally {
    delete doc.elementFromPoint;
    delete doc.activeElement;
  }
});

test('re-render: a gone element hands its ref to the one twin with its tag, role and name', () => {
  const $ = load('<div id=a><button>Save</button></div><div id=b><button>Submit</button></div><div id=c><a href=/x>Docs</a></div>');
  const lines = call('tree', { filter: 'interactive' }).value.lines;
  const save = refAt(lines, 'button "Save"');
  const submit = refAt(lines, 'button "Submit"');
  const docs = refAt(lines, 'link "Docs"');
  // the same control, rendered again
  $('a').innerHTML = '<button id=save2>Save</button>';
  assert.equal(agent.element(save), $('save2'));
  assert.equal(refAt(call('tree', { filter: 'interactive' }).value.lines, 'button "Save"'), save, 'the ref stays the same');
  // a different control took its place: stale
  $('b').innerHTML = '<button>Delete account</button>';
  assert.equal(agent.element(submit), null);
  // two twins: ambiguous, stale
  $('c').innerHTML = '<a href=/x>Docs</a><a href=/y>Docs</a>';
  assert.equal(agent.element(docs), null);
});

test('re-render: an element that kept its place but changed role or name stays stale, and a nameless one never moves', () => {
  const $ = load('<button id=keep>Pay</button><div id=box><button aria-label=""></button></div><span id=t>Plain words</span>');
  const pay = agent.refFor($('keep')).ref;
  $('keep').textContent = 'Pay now';
  assert.equal(agent.element(pay), null, 'renamed in place: not re-bound');
  const nameless = agent.refFor($('box').firstChild).ref;
  $('box').innerHTML = '<button aria-label=""></button>';
  assert.equal(agent.element(nameless), null);
  // a generic element found by its own text is never re-bound
  const found = call('find', { query: 'Plain words' }).value.lines[0].match(/ref_\d+/)[0];
  $('t').remove();
  doc.body.insertAdjacentHTML('beforeend', '<span>Plain words</span>');
  assert.equal(agent.element(found), null);
});

test("re-render: the twin is searched in the ref's own document, through its shadow roots, and its other ref is kept", () => {
  const $ = load('<iframe id=f></iframe><x-host id=h></x-host>');
  const fdoc = frameDoc($('f'), '<button id=fb>Frame save</button>');
  const ref = agent.refFor(fdoc.getElementById('fb')).ref;
  fdoc.body.innerHTML = '<button id=fb2>Frame save</button>';
  assert.equal(agent.element(ref), fdoc.getElementById('fb2'));
  // a twin inside a shadow root
  const sr = $('h').attachShadow({ mode: 'open' });
  sr.innerHTML = '<button>Shadow save</button>';
  const old = agent.refFor(sr.firstChild).ref;
  sr.innerHTML = '<button id=s2>Shadow save</button>';
  const twin = sr.getElementById('s2');
  const own = agent.refFor(twin).ref;
  assert.equal(agent.element(old), twin);
  assert.equal(agent.refFor(twin).ref, own, 'a twin that already had a ref keeps it');
});

test('closed roots: a custom element not upgraded yet is not offered, so its root is found once its definition loads', () => {
  const kit = shadowKit();
  const $ = load('<late-card id=late></late-card><odd-card id=odd></odd-card>');
  define($('late'), 'matches', { value: (s: string) => s !== ':defined' });
  define($('odd'), 'matches', {
    value: () => {
      throw new Error('no :defined');
    },
  });
  assert.deepEqual(kit.closedHosts(), [$('odd')], 'unknown :defined support counts as upgraded');
  kit.shadowOf($('late'));
  assert.equal(kit.takePending(), false, 'an undefined element flags nothing');
  delete $('late').matches;
  assert.deepEqual(kit.closedHosts(), [$('late')]);
});

test('shadowKit on its own: deep walks same-origin frames only when asked, and a frame that throws is skipped', () => {
  const kit = shadowKit();
  const $ = load('<iframe id=same></iframe><iframe id=cross></iframe><q-x id=q></q-x>');
  frameDoc($('same'), '<w-in id=w></w-in>');
  supportDefined($('same').contentWindow);
  upgrade($('same').contentWindow, 'w-in');
  define($('cross'), 'contentDocument', {
    get() {
      throw Object.assign(new Error('Blocked a frame from accessing a cross-origin frame.'), { name: 'SecurityError' });
    },
  });
  const names = (els: any[]) => els.map((e) => e.localName);
  assert.deepEqual(names(kit.deep(doc)), ['html', 'head', 'body', 'iframe', 'iframe', 'q-x']);
  assert.ok(names(kit.deep(doc, true)).includes('w-in'));
  // any other failure is not a cross-origin frame: it is raised, not hidden
  const odd = doc.createElement('iframe');
  define(odd, 'contentDocument', {
    get() {
      throw new Error('detached');
    },
  });
  assert.throws(() => kit.deep({ querySelectorAll: () => [odd] }, true), /detached/);
  assert.deepEqual(names(kit.closedHosts(1)), ['w-in'], 'the limit bounds one read');
  assert.equal(kit.shadowOf(null), null);
  assert.equal(kit.shadowOf(doc.createTextNode('t')), null);
  assert.equal(kit.takePending(), false);
  kit.shadowOf($('q'));
  assert.equal(kit.takePending(), true);
  assert.equal(kit.takePending(), false, 'reading the flag clears it');
  // a meta without a document, a tag or a name is never re-bound
  assert.equal(
    kit.rebind({ role: 'button', name: 'x' }, () => true),
    null,
  );
  assert.equal(
    kit.rebind({ role: 'button', name: 'x', tag: 'button', doc: { deref: () => undefined } }, () => true),
    null,
  );
});

test('reload: a ref the document never minted moves only to the one tag, role and name twin on the same page', () => {
  const $ = load(
    '<form id=f><textarea id=n aria-label="Add note"></textarea><button id=b>Add note</button><button>Save deal</button></form>',
  );
  const here = `${win.location.origin}${win.location.pathname}${win.location.search}`;
  const hints = {
    ref_9001: ['textbox', 'Add note', 'textarea', here],
    ref_9002: ['button', 'Add note', 'button', here],
    ref_9003: ['button', 'Save deal', 'button', 'https://other.test/page'],
    ref_9004: ['button', 'Delete', 'button', here],
    ref_9005: ['generic', 'Add note', 'div', here],
  };
  const out = agent.call('inspect', { refs: ['ref_9001', 'ref_9002'], what: 'state' }, 9100, hints);
  assert.equal(agent.element('ref_9001'), $('n'), 'the same control, rendered by a new document');
  assert.equal(agent.element('ref_9002'), $('b'));
  assert.equal(agent.element('ref_9003'), null, 'another page: never re-resolved');
  assert.equal(agent.element('ref_9004'), null, 'no such control now');
  assert.equal(agent.element('ref_9005'), null, 'a generic element is never re-bound');
  assert.equal(out.minted, undefined, 'adopting a ref is not minting one');
  // two controls with the same tag, role and name: ambiguous, so stale, never a guess
  doc.body.insertAdjacentHTML('beforeend', '<button>Add note</button>');
  assert.equal(agent.element('ref_9006', { ref_9006: ['button', 'Add note', 'button', here] }), null);
  // the element() hand-over: a hint that fits adopts, one already known is left alone
  const known = agent.refFor($('n')).ref;
  assert.equal(agent.element(known, { [known]: ['button', 'Other', 'button', here] }), $('n'));
  assert.equal(agent.element('ref_9007', { ref_9007: 'bad' }), null);
  assert.equal(agent.element('ref_9009', { ref_9009: null }), null);
  assert.equal(agent.element('ref_9008', null), null);
});

test('reload: a call reports the refs it minted and the page, and none when it minted nothing', () => {
  load('<button id=go>Go</button>');
  const first = agent.call('tree', { filter: 'interactive' });
  assert.deepEqual(
    first.minted.map((m: any[]) => m.slice(1)),
    [['button', 'Go', 'button']],
  );
  assert.equal(first.url, `${win.location.origin}${win.location.pathname}${win.location.search}`);
  const again = agent.call('tree', { filter: 'interactive' });
  assert.equal(again.minted, undefined);
  assert.equal(again.url, undefined);
});

test('reload: only a ref that named the one element of its tag, role and name in this document is reported', () => {
  load('<ul><li><button>Delete</button></li><li><button>Delete</button></li></ul><button id=one>Archive</button><iframe id=f></iframe>');
  const frame = frameDoc(doc.getElementById('f'), '<button>Submit</button>');
  assert.equal(frame.body.firstChild.localName, 'button');
  // a call that minted only look-alikes reports nothing at all
  const deletes = call('find', { query: 'delete' });
  assert.equal(deletes.minted, undefined);
  assert.equal(deletes.url, undefined);
  const out = agent.call('tree', { filter: 'interactive' });
  const rows = out.minted.map((m: any[]) => m.slice(1));
  assert.deepEqual(rows, [['button', 'Archive', 'button']], 'look-alikes and a frame element are not reported');
});
