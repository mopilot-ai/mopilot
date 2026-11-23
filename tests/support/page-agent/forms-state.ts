// Page-agent forms-state unit cases, using the shared DOM and agent fixture.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { win, doc, G, define, agent, run, load, refAt } from './fixture';

export function registerFormsStateCases() {
  /** Records the input/change events an element fires. */
  const listen = (el: any) => {
    const events: string[] = [];
    const InputEvent = win.InputEvent;
    for (const type of ['input', 'change'])
      el.addEventListener(type, (e: any) =>
        events.push(`${type}:${e instanceof InputEvent ? 'InputEvent' : 'Event'}:${e.bubbles}:${e.composed}`),
      );
    return events;
  };
  /** happy-dom caches selectedOptions; browsers derive it from the options' current state. */
  const liveSelectedOptions = (select: any) =>
    define(select, 'selectedOptions', { get: () => [...select.options].filter((o: any) => o.selected) });

  test('formInput picks select options by value or text and lists the options on a miss', () => {
    const $ = load(
      '<select id=one aria-label="One"><option value="a">Alpha</option><option value="b">Beta</option></select><select id=many multiple aria-label="Many"><option value="r">Red</option><option value="g" selected>Green</option><option value="b">Blue</option></select>',
    );
    liveSelectedOptions($('one'));
    liveSelectedOptions($('many'));
    const one = agent.refFor($('one')).ref;
    const events = listen($('one'));
    assert.deepEqual(run('formInput', { ref: one, value: ' Beta ' }), { ok: true, value: 'Beta' });
    assert.deepEqual(events, ['input:InputEvent:true:true', 'change:Event:true:true']);
    assert.deepEqual(run('formInput', { ref: one, value: 'a' }), { ok: true, value: 'Alpha' });
    assert.equal($('one').value, 'a');
    assert.deepEqual(run('formInput', { ref: one, value: 'zzz' }), { error: 'No option matches. Options: "Alpha" (a), "Beta" (b)' });
    assert.equal(events.length, 4);

    const many = agent.refFor($('many')).ref;
    assert.deepEqual(run('formInput', { ref: many, value: ['Red', 'b'] }), { ok: true, value: 'Red, Blue' });
    assert.deepEqual(
      [...$('many').options].map((o: any) => o.selected),
      [true, false, true],
    );
    const manyEvents = listen($('many'));
    assert.deepEqual(run('formInput', { ref: many, value: ['Purple'] }), {
      error: 'No option matches. Options: "Red" (r), "Green" (g), "Blue" (b)',
    });
    assert.deepEqual(
      [...$('many').options].map((o: any) => o.selected),
      [true, false, true],
      'a miss leaves the selection as it was',
    );
    assert.deepEqual(manyEvents, []);
  });

  test('formInput toggles checkboxes and radios from booleans and strings', () => {
    const $ = load('<input id=cb type=checkbox aria-label="Agree"><input id=rd type=radio name=g aria-label="Radio">');
    const cb = agent.refFor($('cb')).ref;
    let clicks = 0;
    $('cb').addEventListener('click', () => clicks++);
    assert.deepEqual(run('formInput', { ref: cb, value: true }), { ok: true, value: true });
    assert.deepEqual(run('formInput', { ref: cb, value: true }), { ok: true, value: true });
    assert.equal(clicks, 1);
    assert.deepEqual(run('formInput', { ref: cb, value: 'off' }), { ok: true, value: false });
    assert.deepEqual(run('formInput', { ref: cb, value: 'YES' }), { ok: true, value: true });
    assert.deepEqual(run('formInput', { ref: cb, value: false }), { ok: true, value: false });
    assert.deepEqual(run('formInput', { ref: cb, value: 1 }), { ok: true, value: true });
    assert.equal(clicks, 5);
    assert.deepEqual(run('formInput', { ref: agent.refFor($('rd')).ref, value: 'checked' }), { ok: true, value: true });
    assert.equal($('rd').checked, true);
  });

  test('formInput sets text fields through the native setter and fires input and change', () => {
    const $ = load(
      '<input id=txt aria-label="Name"><textarea id=ta aria-label="Bio"></textarea><input id=pw type=password aria-label="Pw">',
    );
    const txt = $('txt');
    // a framework-style instance override of value must not intercept the write
    const proto = Object.getOwnPropertyDescriptor(win.HTMLInputElement.prototype, 'value')!;
    define(txt, 'value', {
      get() {
        return proto.get!.call(this);
      },
      set() {
        throw new Error('instance setter used');
      },
    });
    const events = listen(txt);
    assert.deepEqual(run('formInput', { ref: agent.refFor(txt).ref, value: 'Ada' }), { ok: true, value: 'Ada' });
    assert.equal(doc.activeElement, txt);
    assert.deepEqual(events, ['input:InputEvent:true:true', 'change:Event:true:true']);

    const ta = $('ta');
    const taEvents = listen(ta);
    const saved = win.InputEvent;
    win.InputEvent = undefined;
    try {
      assert.deepEqual(run('formInput', { ref: agent.refFor(ta).ref, value: 42 }), { ok: true, value: '42' });
    } finally {
      win.InputEvent = saved;
    }
    assert.deepEqual(taEvents, ['input:Event:true:true', 'change:Event:true:true']);

    assert.deepEqual(run('formInput', { ref: agent.refFor($('pw')).ref, value: 'secret' }), { ok: true, value: '••••' });
    assert.equal($('pw').value, 'secret');
  });

  test('formInput replaces contenteditable text with insertText, or sets it directly when that fails', () => {
    const $ = load('<div id=ce contenteditable="true" aria-label="Editor">old <b>text</b></div>');
    const ce = $('ce');
    const ref = agent.refFor(ce).ref;
    const commands: any[] = [];
    doc.execCommand = (cmd: string, ui: boolean, value: string) => {
      commands.push([cmd, ui, value, String(win.getSelection())]);
      ce.textContent = value;
      return true;
    };
    const events = listen(ce);
    try {
      assert.deepEqual(run('formInput', { ref, value: 'new' }), { ok: true, value: 'new' });
      assert.deepEqual(commands, [['insertText', false, 'new', 'old text']]);
      assert.equal(doc.activeElement, ce);
      assert.deepEqual(events, []);
      doc.execCommand = () => false;
      assert.deepEqual(run('formInput', { ref, value: 'fallback' }), { ok: true, value: 'fallback' });
      assert.equal(ce.textContent, 'fallback');
      assert.deepEqual(events, ['input:InputEvent:true:true']);
    } finally {
      delete doc.execCommand;
    }
  });

  test('formInput refuses disabled fields, file inputs, non-fields and stale refs', () => {
    const $ = load(
      '<input id=dis disabled aria-label="Dis"><input id=file type=file aria-label="Upload"><div id=plain tabindex="0">x</div>',
    );
    assert.deepEqual(run('formInput', { ref: agent.refFor($('dis')).ref, value: 'x' }), { error: 'This field is disabled.' });
    assert.deepEqual(run('formInput', { ref: agent.refFor($('file')).ref, value: 'x' }), {
      error: 'This is a file input. Use browser_file_upload.',
    });
    assert.deepEqual(run('formInput', { ref: agent.refFor($('plain')).ref, value: 'x' }), {
      error: 'This element (div) is not a form field.',
    });
    assert.deepEqual(run('formInput', { ref: 'ref_999999999', value: 'x' }), { error: 'stale', ref: 'ref_999999999' });
  });

  test('state reports geometry, readiness and DOM mutation activity', async () => {
    load('<p>state</p>');
    doc.title = 'State page';
    await new Promise((r) => setTimeout(r, 0));
    const before = run('state');
    doc.body.appendChild(doc.createElement('div'));
    doc.body.setAttribute('data-x', '1');
    await new Promise((r) => setTimeout(r, 0));
    const s = run('state');
    assert.ok(s.mutations >= before.mutations + 2, `${before.mutations} -> ${s.mutations}`);
    assert.ok(s.quietMs >= 0 && s.quietMs < 1000);
    assert.deepEqual(
      { ...s, quietMs: 0, mutations: 0 },
      {
        w: 1024,
        h: 768,
        dpr: 2,
        sx: 0,
        sy: 40,
        visibility: 'visible',
        ready: doc.readyState,
        quietMs: 0,
        mutations: 0,
        url: 'https://site.test/start',
        title: 'State page',
      },
    );
  });

  test('call and refFor raise the ref counter to the tab sequence and never lower it', () => {
    const $ = load('<button id=a>A</button><button id=b>B</button>');
    const base = agent.call('state').seq;
    assert.equal(agent.call('state', undefined, base + 100).seq, base + 100);
    assert.equal(agent.call('state', undefined, 1).seq, base + 100);
    assert.equal(agent.call('state', undefined, String(base + 500)).seq, base + 100);
    assert.deepEqual(agent.call('nope', {}, base + 100), { value: { error: 'unknown op nope' }, seq: base + 100 });
    const found = agent.call('find', { query: 'a' });
    assert.equal(refAt(found.value.lines, '- button "A"'), `ref_${base + 101}`);
    assert.equal(found.seq, base + 101);
    assert.deepEqual(agent.refFor($('b'), base + 200), { ref: `ref_${base + 201}`, seq: base + 201 });
    assert.deepEqual(agent.refFor($('b'), 5), { ref: `ref_${base + 201}`, seq: base + 201 });
    assert.deepEqual(agent.refFor($('b'), 'x'), { ref: `ref_${base + 201}`, seq: base + 201 });
  });

  test('the ref table prunes collected elements once it passes 20000 entries', () => {
    // twins keep a collected ref from moving to a look-alike (pageAgentShadow.cjs rebind)
    const $ = load(
      '<button id=keep>Keep</button><button id=early>Early</button><button id=late>Late</button><button>Early</button><button>Late</button>',
    );
    const dead = new Set<object>();
    const RealWeakRef = G.WeakRef;
    G.WeakRef = class {
      target: object;
      constructor(target: object) {
        this.target = target;
      }
      deref() {
        return dead.has(this.target) ? undefined : this.target;
      }
    };
    let keep: string, early: string, late: string, fresh: string;
    try {
      keep = agent.refFor($('keep')).ref;
      early = agent.refFor($('early')).ref;
      dead.add($('early'));
      for (let i = 0; i < 6000; i++) {
        const el = doc.createElement('div');
        dead.add(el);
        agent.refFor(el);
      }
      late = agent.refFor($('late')).ref;
      dead.add($('late'));
      assert.equal(agent.element(late), null);
      for (let i = 0; i < 14000; i++) agent.refFor(doc.createElement('div'));
      dead.clear();
      // the oldest collected entries went, enough to get back to 15000; later ones and live ones stay
      assert.equal(agent.element(early), null);
      assert.equal(agent.element(late), $('late'));
      assert.equal(agent.element(keep), $('keep'));
      fresh = agent.refFor($('early')).ref;
    } finally {
      G.WeakRef = RealWeakRef;
    }
    assert.notEqual(fresh, early);
    assert.equal(agent.refFor($('late')).ref, late);
    assert.equal(agent.element(fresh), $('early'));
  });
}
