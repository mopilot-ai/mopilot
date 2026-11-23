// Actual side-panel card DOM preserves form drafts across reads and fences stale answers; irreversible permission holds cancel on release, blur and withdrawal.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { window } from './support/dom.ts';
import type { HTMLInputElement, HTMLSelectElement, HTMLTextAreaElement } from 'happy-dom';
import { fixture, card, click, tick, trusted } from './support/panel-card-controls.ts';
for (const fails of [false, true])
  test(`an answer ${fails ? 'failure' : 'success'} refreshes the same request after its busy card was redrawn`, async () => {
    const f = fixture();
    const c = card();
    f.view.render('chat', [c]);
    let settle: any;
    f.reply(
      () =>
        new Promise((resolve, reject) => {
          settle = fails ? reject : resolve;
        }),
    );
    click(f.container.querySelector('button')!);
    await tick();
    f.view.render('chat', [{ ...c, disabled: true, choices: [], detail: 'Sending your answers…' }]);
    settle(fails ? new Error('Offline') : {});
    await tick();
    assert.equal(f.reads(), 1);
    assert.equal(f.errors.includes('Offline'), fails);
  });

test('question inputs survive stream refreshes and a rejected submit, and carry the exact request version', async () => {
  const f = fixture();
  const c = card({
    questions: [
      { id: 'q', question: 'Which hotel?', options: [{ label: 'A', description: 'Near the station' }, { label: 'B' }], isOther: true },
    ],
  });
  f.view.render('chat', [c]);
  const input = f.container.querySelector('input[type=text]') as HTMLInputElement;
  input.value = 'C';
  input.focus();
  f.view.render('chat', [{ ...c }]);
  assert.equal(f.container.querySelector('input[type=text]'), input);
  assert.equal(window.document.activeElement, input);
  f.reply(() => {
    throw new Error('Try again');
  });
  click(f.container.querySelector('button')!);
  await tick();
  assert.equal(input.value, 'C');
  assert.deepEqual(f.errors.filter(Boolean), ['Try again']);
  assert.deepEqual(f.calls[0], [
    'answer',
    { chatId: 'chat', approvalId: 'request', version: 'v1', choice: 'submit', values: { q: ['C'] } },
  ]);
  f.reply(() => ({}));
  click(f.container.querySelector('button')!);
  await tick();
  assert.equal(f.reads(), 2);
});

test('old controls and pending replies cannot answer a replaced card or affect another chat', async () => {
  const f = fixture();
  const c = card();
  f.view.render('chat', [c]);
  const old = f.container.querySelector('button')!;
  f.view.render('chat', [card({ version: 'v2' })]);
  click(old);
  assert.equal(f.calls.length, 0);
  let finish: any;
  f.reply(
    () =>
      new Promise((r) => {
        finish = r;
      }),
  );
  click(f.container.querySelector('button')!);
  click(f.container.querySelector('button')!);
  assert.equal(f.calls.length, 1);
  f.view.render('other', [c]);
  finish({});
  await tick();
  assert.equal(f.reads(), 0);
  f.view.render('other', []);
  assert.equal(f.container.childElementCount, 0);
});

test('irreversible cards require a trusted full hold, and release, focus loss or withdrawal cancels it', async () => {
  const f = fixture();
  const c = card({ choices: [{ key: 'once', label: 'Allow once', hold: true }] });
  f.view.render('chat', [c]);
  const b = f.container.querySelector('button')!;
  b.dispatchEvent(new window.PointerEvent('pointerdown', { button: 0 }));
  assert.equal(f.timeouts.size, 0);
  click(b);
  assert.equal(f.calls.length, 0);
  const start = () => b.dispatchEvent(trusted(new window.PointerEvent('pointerdown', { button: 0, bubbles: true })));
  start();
  window.document.dispatchEvent(new window.PointerEvent('pointerup'));
  assert.equal(f.timeouts.size, 0);
  start();
  window.dispatchEvent(new window.Event('blur'));
  assert.equal(f.timeouts.size, 0);
  start();
  f.view.render('chat', []);
  assert.equal(f.timeouts.size, 0);
  f.view.render('chat', [c]);
  const current = f.container.querySelector('button')!;
  current.dispatchEvent(trusted(new window.KeyboardEvent('keydown', { key: 'Enter', metaKey: true })));
  assert.equal(f.timeouts.size, 1);
  f.view.render('chat', [c]);
  assert.equal(f.timeouts.size, 1, 'stream read preserves the held gesture');
  const fire = [...f.timeouts.values()][0];
  fire();
  await tick();
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0][1].choice, 'once');
});

test('form fields preserve types, rejection never parses invalid JSON, and URLs stay web-only', async () => {
  const f = fixture();
  const c = card({
    schema: {
      properties: {
        flag: { type: 'boolean' },
        count: { type: 'integer' },
        value: { enum: [2, 'Two'] },
        rows: { type: 'array' },
        note: { type: 'string' },
      },
    },
    url: 'javascript:alert(1)',
  });
  f.view.render('chat', [c]);
  assert.equal(f.container.querySelector('a')?.getAttribute('href'), null);
  const inputs = f.container.querySelectorAll('input');
  (inputs[0] as HTMLInputElement).checked = true;
  (inputs[1] as HTMLInputElement).value = '3';
  (f.container.querySelector('select') as HTMLSelectElement).value = '0';
  (f.container.querySelector('textarea') as HTMLTextAreaElement).value = '[';
  click(f.container.querySelector('button')!);
  assert.match(f.errors[0], /valid JSON/);
  click(f.container.querySelectorAll('button')[1]);
  await tick();
  assert.equal(f.calls[0][1].choice, 'deny');
  assert.equal(f.calls[0][1].values, undefined);
  f.view.render('chat', [card({ ...c, version: 'v2', url: 'https://example.com', choices: [{ key: 'submit', label: 'Send' }] })]);
  assert.equal(f.container.querySelector('a')?.getAttribute('rel'), 'noopener noreferrer');
  const input = f.container.querySelectorAll('input');
  (input[0] as HTMLInputElement).checked = true;
  (input[1] as HTMLInputElement).value = '3';
  (f.container.querySelector('select') as HTMLSelectElement).value = '0';
  (f.container.querySelector('textarea') as HTMLTextAreaElement).value = '[1]';
  click(f.container.querySelector('button')!);
  await tick();
  assert.deepEqual(f.calls.at(-1)[1].values, { flag: true, count: 3, value: 2, rows: [1] });
});

test('multi choice, secret free text, app selection and levels return only their offered typed values', async () => {
  const f = fixture();
  const c = card({
    questions: [
      { id: 'multi', header: 'Many', multiSelect: true, isOther: true, options: [{ label: 'A' }] },
      { id: 'secret', isSecret: true },
      { id: 'single', options: [{ label: 'B' }] },
    ],
    apps: [
      { name: 'Notes', bundleId: 'notes' },
      { name: 'TextEdit', bundleId: 'textedit' },
    ],
    levels: [
      { id: 'read', label: 'Read' },
      { id: 'write', label: 'Write' },
    ],
    level: 'write',
  });
  f.view.render('chat', [c]);
  const sets = f.container.querySelectorAll('fieldset');
  (sets[0].querySelector('input[type=checkbox]') as HTMLInputElement).checked = true;
  (sets[0].querySelector('input[type=text]') as HTMLInputElement).value = 'Other';
  (sets[1].querySelector('input') as HTMLInputElement).value = 'Private';
  (sets[2].querySelector('input') as HTMLInputElement).checked = true;
  const checkboxes = f.container.querySelectorAll('input[type=checkbox]');
  (checkboxes[2] as HTMLInputElement).checked = false;
  click(f.container.querySelector('button')!);
  await tick();
  assert.deepEqual(f.calls[0][1].values, { multi: ['A', 'Other'], secret: ['Private'], single: ['B'], apps: ['notes'], level: 'write' });
  f.view.render('chat', [card({ version: 'empty', schema: {} })]);
  click(f.container.querySelector('button')!);
  await tick();
  assert.deepEqual(f.calls.at(-1)[1].values, {});
});

test('all-sites permission requires the second trusted confirmation, and bare schemas retain typed optional fields', async () => {
  const f = fixture();
  const c = card({
    choices: [{ key: 'allSites', label: 'All sites', confirm: 'Allow every site?' }],
    schema: { properties: { text: { type: 'string', title: 'Text' }, optional: { enum: ['A'] } } },
  });
  f.view.render('chat', [c]);
  (f.container.querySelector('input') as HTMLInputElement).value = 'Typed';
  const b = f.container.querySelector('button')!;
  b.dispatchEvent(new window.MouseEvent('click'));
  assert.equal(f.calls.length, 0);
  click(b);
  assert.equal(f.calls.length, 0);
  assert.equal(b.textContent, 'Confirm permission');
  click(b);
  await tick();
  assert.deepEqual(f.calls[0][1].values, { text: 'Typed' });
});

test('held cards reject wrong chords/buttons, cancel on hidden document and cannot fire after withdrawal', async () => {
  const f = fixture();
  f.view.render('chat', [card({ choices: [{ key: 'once', label: 'Hold', hold: true }] })]);
  const b = f.container.querySelector('button')!;
  for (const e of [
    new window.KeyboardEvent('keydown', { key: 'x', metaKey: true }),
    new window.KeyboardEvent('keydown', { key: 'Enter' }),
    new window.KeyboardEvent('keydown', { key: 'Enter', metaKey: true, isComposing: true }),
    new window.KeyboardEvent('keydown', { key: 'Enter', metaKey: true, keyCode: 229 }),
    new window.PointerEvent('pointerdown', { button: 1 }),
  ])
    b.dispatchEvent(trusted(e));
  assert.equal(f.timeouts.size, 0);
  b.dispatchEvent(trusted(new window.PointerEvent('pointerdown', { button: 0 })));
  const oldTimer = [...f.timeouts.values()][0];
  window.document.dispatchEvent(new window.Event('visibilitychange'));
  Object.defineProperty(window.document, 'hidden', { configurable: true, value: true });
  window.document.dispatchEvent(new window.Event('visibilitychange'));
  assert.equal(f.timeouts.size, 0);
  Object.defineProperty(window.document, 'hidden', { configurable: true, value: false });
  f.view.render('chat', []);
  oldTimer();
  assert.equal(f.calls.length, 0);
});

test('native ACP defaults retain arrays, labels and exact numeric parsing, and a disabled refresh keeps the draft', async () => {
  const f = fixture();
  const c = card({
    schema: {
      properties: {
        places: { type: 'array', items: { enum: ['a', 'b'], enumLabels: ['Taipei', 'Tainan'] }, default: ['b'] },
        price: { type: 'number', preciseNumber: true, default: 1.25 },
      },
    },
  });
  f.view.render('chat', [c]);
  assert.match(f.container.textContent, /Taipei.*Tainan/);
  const checks = f.container.querySelectorAll('input[type=checkbox]');
  assert.equal((checks[1] as HTMLInputElement).checked, true);
  const price = f.container.querySelector('input[type=number]') as HTMLInputElement;
  price.value = '0.123456789012345678901';
  click(f.container.querySelector('button')!);
  await tick();
  assert.equal(f.calls.length, 0);
  assert.match(f.errors.at(-1)!, /precision|represent/i);
  price.value = '1.5';
  f.view.render('chat', [{ ...c, disabled: true, detail: 'Delivery failed', choices: [] }]);
  assert.equal((f.container.querySelector('input[type=number]') as HTMLInputElement).value, '1.5');
  assert.equal((f.container.querySelector('input[type=number]') as HTMLInputElement).disabled, true);
  f.view.render('chat', [c]);
  click(f.container.querySelector('button')!);
  await tick();
  assert.deepEqual(f.calls[0][1].values, { places: ['b'], price: 1.5 });
});

test('the global hold shortcut acts only on the first card, leaves typed fields alone and cancels on key release', async () => {
  const f = fixture();
  f.view.render('chat', [
    card({ choices: [{ key: 'once', label: 'Hold', hold: true }] }),
    card({ id: 'second', choices: [{ key: 'once', label: 'Hold second', hold: true }] }),
  ]);
  const chord = () => window.dispatchEvent(trusted(new window.KeyboardEvent('keydown', { key: 'Enter', metaKey: true })));
  window.document.body.focus();
  chord();
  assert.equal(f.timeouts.size, 1);
  chord();
  assert.equal(f.timeouts.size, 1);
  window.document.dispatchEvent(new window.KeyboardEvent('keyup', { key: 'Meta' }));
  assert.equal(f.timeouts.size, 0);
  const input = window.document.createElement('input');
  f.container.append(input);
  input.focus();
  chord();
  assert.equal(f.timeouts.size, 0);
  window.document.body.focus();
  f.view.render('chat', []);
  chord();
  assert.equal(f.timeouts.size, 0);
});

test('schema controls retain booleans, password entry, unset enums and structured defaults without coercing values', () => {
  const f = fixture();
  const boolean = f.view.field({ type: 'boolean', default: true });
  assert.equal(boolean.read(), true);
  const secret = f.view.field({ type: 'string', format: 'password' });
  assert.equal(secret.el.type, 'password');
  secret.el.value = 'temporary';
  assert.equal(secret.read(), 'temporary');
  const opaque = f.view.field({ type: 'string', writeOnly: true });
  assert.equal(opaque.el.type, 'password');
  const select = f.view.field({ type: 'string', enum: ['A', 'B'], default: 'B' });
  assert.equal(select.read(), 'B');
  select.el.value = '';
  assert.equal(select.read(), undefined);
  const choices = f.view.field({ type: 'array', items: { enum: ['A', 'B'] } });
  assert.deepEqual(choices.read(), []);
  const complex = f.view.field({ type: 'object', default: { hotel: 'Taipei' } });
  assert.deepEqual(complex.read(), { hotel: 'Taipei' });
});

test('held approvals fence a retired callback and duplicate pending keyboard holds with no document window', async () => {
  const f = fixture();
  f.view.doc = { createElement: window.document.createElement.bind(window.document), defaultView: null };
  f.view.render('chat', [card({ choices: [{ key: 'once', label: 'Hold', hold: true }] })]);
  let finish: any;
  f.reply(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const b = f.container.querySelector('button')!;
  const hold = () => b.dispatchEvent(trusted(new window.PointerEvent('pointerdown', { button: 0 })));
  hold();
  [...f.timeouts.values()][0]();
  assert.equal(f.calls.length, 1);
  finish({});
  await tick();
});

test('a held permission timer cannot answer after another choice claimed the native request', async () => {
  const f = fixture();
  f.view.render('chat', [
    card({
      choices: [
        { key: 'once', label: 'Hold', hold: true },
        { key: 'deny', label: 'Deny', deny: true },
      ],
    }),
  ]);
  let finish: any;
  f.reply(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  window.document.body.focus();
  window.dispatchEvent(trusted(new window.KeyboardEvent('keydown', { key: 'Enter', metaKey: true })));
  const held = [...f.timeouts.values()][0];
  // A keyboard activation can select Deny before the held keys are released or their timer fires.
  click(f.container.querySelectorAll('button')[1]);
  assert.equal(f.calls.length, 1);
  held();
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0][1].choice, 'deny');
  finish({});
  await tick();
});

test('an enum’s display label does not replace the value delivered to its native form', () => {
  const f = fixture();
  const field = f.view.field({ type: 'string', enum: ['a'], enumLabels: ['Taipei'], default: 'a' });
  assert.match(field.el.textContent, /Taipei/);
  assert.equal(field.read(), 'a');
});

test('ordinary MCP numeric fields reject precision loss before forming a protocol answer', () => {
  const f = fixture();
  const field = f.view.field({ type: 'integer' });
  field.el.value = '9007199254740993';
  assert.throws(() => field.read(), /precision|precise|exact|large/i);
  field.el.value = '42';
  assert.equal(field.read(), 42);
});

test('an untouched optional enum array with a minimum can be omitted while required fields are answered', async () => {
  const f = fixture();
  f.view.render('chat', [
    card({
      schema: {
        type: 'object',
        required: ['name'],
        properties: {
          name: { type: 'string' },
          places: { type: 'array', minItems: 1, items: { type: 'string', enum: ['Taipei'] } },
        },
      },
    }),
  ]);
  (f.container.querySelector('input[type=text]') as HTMLInputElement).value = 'Guest';
  click(f.container.querySelector('.choices button')!);
  await tick();
  assert.deepEqual(f.calls[0][1].values, { name: 'Guest' });
});

for (const title of [undefined, 'Choose'])
  test(`a failed broad-permission answer needs a fresh second confirmation before retrying (${title})`, async () => {
    const f = fixture();
    f.reply(() => {
      throw new Error('Delivery failed');
    });
    f.view.render('chat', [card({ title, choices: [{ key: 'allSites', label: 'All sites', confirm: 'Allow every site?' }] })]);
    const b = f.container.querySelector('button')!;
    click(b);
    click(b);
    await tick();
    assert.equal(f.calls.length, 1);
    click(b);
    assert.equal(f.calls.length, 1);
    assert.equal(b.textContent, 'Confirm permission');
    f.reply(() => ({}));
    click(b);
    await tick();
    assert.equal(f.calls.length, 2);
  });
