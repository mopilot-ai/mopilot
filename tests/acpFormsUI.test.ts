// Real ACP form cards preserve drafts and native values, and expose explicit submit/decline/cancel with safe IPC recovery.
import { test, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { window } from './support/dom.ts';
import { createElement as h, act } from 'react';
import { createRoot } from 'react-dom/client';
import { parseAcpForm } from '../shared/acpForm.mjs';
import { installNativeStub } from './support/ports/native.ts';
let questions: any[] = [];
const sent: any[] = [];
let answer: any = async () => ({ status: 'written' });
let snapshot: any = async () => ({ questions });
mock.module('../src/store/session/useSession.ts', {
  namedExports: {
    flushSessionPatches: () => {},
    useSession: () => ({ questions }),
    useSessionField: (id: any, pick: any) => pick(((() => ({ questions })) as (id: any) => any)(id)),
  },
});
installNativeStub({
  session: {
    answerQuestion: (...a: any[]) => {
      sent.push(a);
      return answer(...a);
    },
    snapshot: (...a: any[]) => snapshot(...a),
  },
});
const { AcpQuestions, AcpFormCard } = await import('../src/components/thread/AcpQuestions.tsx');
await import('../src/store/session/sessionState.ts');
await import('../src/lib/native/session.ts');
let serial = 0;
const roots: any[] = [];
const form = (properties: any, required: string[] = []) => parseAcpForm({ type: 'object', properties, required });
function question(properties: any, required: string[] = [], extra: any = {}) {
  return {
    id: `q${++serial}`,
    kind: 'question',
    status: 'pending',
    harness: 'Kimi',
    message: 'Choose carefully',
    toolCallId: 'tool',
    form: form(properties, required),
    error: null,
    ...extra,
  };
}
async function render(q: any, readOnly = false) {
  const el = document.createElement('div');
  document.body.append(el);
  const root = createRoot(el);
  roots.push(root);
  await act(async () => root.render(h(AcpFormCard, { question: q, threadId: 'chat', readOnly })));
  return { el, root };
}
const click = async (el: Element, text: string) =>
  act(async () => {
    (Array.from(el.querySelectorAll('button')).find((b) => b.textContent === text) as HTMLButtonElement).click();
  });
async function input(el: any, value: string) {
  await act(async () => {
    const prototype = el instanceof window.HTMLSelectElement ? window.HTMLSelectElement.prototype : window.HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(el, value);
    el.dispatchEvent(new window.Event(el instanceof window.HTMLSelectElement ? 'change' : 'input', { bubbles: true }));
  });
}
afterEach(async () => {
  await act(async () => {
    for (const root of roots.splice(0)) root.unmount();
  });
  document.body.innerHTML = '';
  sent.length = 0;
  answer = async () => ({ status: 'written' });
  snapshot = async () => ({ questions });
  questions = [];
});

test('opaque titled choice is reviewed before explicit submit, including an empty choice value', async () => {
  const q = question(
    {
      choice: {
        type: 'string',
        oneOf: [
          { const: '', title: 'Empty' },
          { const: 'opaque', title: 'Friendly', description: 'Keep it' },
        ],
        default: 'opaque',
      },
    },
    ['choice'],
  );
  const { el } = await render(q);
  assert.equal(sent.length, 0);
  assert.equal((el.querySelector('select') as HTMLSelectElement).value, 'v:opaque');
  await input(el.querySelector('select'), 'v:');
  assert.equal(sent.length, 0);
  await click(el, 'Submit');
  assert.deepEqual(sent[0].slice(0, 2), ['chat', q.id]);
  assert.equal(sent[0][2].content.choice, '');
  assert.match(el.textContent!, /Response written/);
  assert.equal(el.querySelectorAll('button:disabled').length, 3);
});

test('free text, numeric zero, optional empty number, explicit false and multi-select remain typed', async () => {
  const q = question(
    {
      text: { type: 'string', description: 'Literal', minLength: 1 },
      number: { type: 'number' },
      optional: { type: 'integer' },
      flag: { type: 'boolean' },
      many: {
        type: 'array',
        description: 'Choose two',
        items: {
          anyOf: [
            { const: 'a', title: 'First', description: 'Alpha' },
            { const: 'b', title: 'Second' },
          ],
        },
        minItems: 1,
      },
    },
    ['text', 'number', 'flag', 'many'],
  );
  const { el } = await render(q);
  const inputs = el.querySelectorAll('input[type=text]');
  await input(inputs[0], ' literal ');
  await input(inputs[1], '0');
  await input(inputs[2], '');
  await input(el.querySelector('select'), 'false');
  await act(async () => {
    (el.querySelectorAll('input[type=checkbox]')[0] as HTMLInputElement).click();
  });
  await act(async () => {
    (el.querySelectorAll('input[type=checkbox]')[1] as HTMLInputElement).click();
  });
  await act(async () => {
    (el.querySelectorAll('input[type=checkbox]')[0] as HTMLInputElement).click();
  });
  await click(el, 'Submit');
  assert.deepEqual({ ...sent[0][2].content }, { text: ' literal ', number: 0, flag: false, many: ['b'] });
});

test('validation preserves input, required boolean remains unset until selected, and defaults do not auto-submit', async () => {
  const q = question({ text: { type: 'string', default: 'keep' }, flag: { type: 'boolean' }, number: { type: 'integer' } }, [
    'flag',
    'number',
  ]);
  const { el } = await render(q);
  await click(el, 'Submit');
  assert.equal(sent.length, 0);
  assert.match(el.textContent!, /Check the required/);
  await input(el.querySelector('select'), 'true');
  await input(el.querySelectorAll('input')[1], 'NaN');
  await click(el, 'Submit');
  assert.equal(sent.length, 0);
  await input(el.querySelectorAll('input')[1], '3');
  await input(el.querySelector('select'), '');
  await click(el, 'Submit');
  assert.equal(sent.length, 0);
  await input(el.querySelector('select'), 'true');
  await click(el, 'Submit');
  assert.equal(sent[0][2].content.flag, true);
  assert.equal(sent[0][2].content.number, 3);
});

test('cancel and decline are distinct and do not require answering required fields', async () => {
  for (const label of ['Cancel', 'Decline']) {
    const q = question({ x: { type: 'string' }, number: { type: 'number' } }, ['x']);
    const { el } = await render(q);
    await input(el.querySelectorAll('input')[1], 'not a number');
    await click(el, label);
    assert.deepEqual(sent.at(-1)[2], { action: label.toLowerCase() });
  }
});

test('duplicate synchronous clicks write once and a known-pending error keeps the draft retryable', async () => {
  let finish: any;
  answer = () => new Promise((r) => (finish = r));
  const q = question({ x: { type: 'string' } });
  const { el } = await render(q);
  await input(el.querySelector('input'), 'keep me');
  await act(async () => {
    const button = el.querySelectorAll('button')[2];
    button.click();
    button.click();
  });
  assert.equal(sent.length, 1);
  assert.match(el.textContent!, /Sending/);
  await act(async () => finish({ status: 'pending', error: 'Try again' }));
  assert.match(el.textContent!, /Try again/);
  assert.equal((el.querySelector('input') as HTMLInputElement).value, 'keep me');
  answer = async () => ({ status: 'written' });
  await click(el, 'Submit');
  assert.equal(sent.length, 2);
});

test('IPC rejection consults authoritative state before retry; missing or unreadable ownership is terminal', async () => {
  for (const recovery of ['pending', 'written', 'missing', 'unreadable']) {
    answer = async () => {
      throw new Error('IPC');
    };
    const q = question({ x: { type: 'string' } });
    const { el } = await render(q);
    await input(el.querySelector('input'), 'draft');
    snapshot = async () => {
      if (recovery === 'unreadable') throw new Error('offline');
      return recovery === 'missing' ? null : { questions: [{ ...q, status: recovery }] };
    };
    await click(el, 'Submit');
    assert.equal((el.querySelector('input') as HTMLInputElement).value, 'draft');
    assert.equal(el.querySelectorAll('button:disabled').length, recovery === 'pending' ? 0 : 3);
    if (recovery === 'unreadable') assert.match(el.textContent!, /could not be confirmed/);
  }
});

test('remount restores this request draft; replacement IDs and read-only/terminal views cannot answer', async () => {
  const q = question({ x: { type: 'string' } });
  const first = await render(q);
  await input(first.el.querySelector('input'), 'retained');
  await act(async () => first.root.unmount());
  roots.splice(roots.indexOf(first.root), 1);
  const second = await render(q);
  assert.equal((second.el.querySelector('input') as HTMLInputElement).value, 'retained');
  const replacement = question({ x: { type: 'string' } });
  const next = await render(replacement);
  assert.equal((next.el.querySelector('input') as HTMLInputElement).value, '');
  for (const extra of [
    { status: 'cancelled' },
    { status: 'retired' },
    { status: 'answered' },
    { status: 'failed', error: 'Disconnected' },
  ]) {
    const r = await render({ ...q, ...extra });
    assert.equal(r.el.querySelectorAll('button:disabled').length, 3);
  }
  // a question the machine's Host took says so in one word, not that the receipt is unconfirmed
  const taken = await render({ ...q, status: 'answered' });
  assert.match(taken.el.textContent!, /Answered\./);
  assert.doesNotMatch(taken.el.textContent!, /Receipt is not confirmed/);
  const read = await render(q, true);
  await click(read.el, 'Submit');
  assert.equal(sent.length, 0);
  assert.match(read.el.textContent!, /main chat/);
});

test('late response on an unmounted card cannot change the replacement card and question list preserves independent requests', async () => {
  let finish: any;
  answer = () => new Promise((r) => (finish = r));
  const q = question({ x: { type: 'string', default: 'a' } });
  const { el, root } = await render(q);
  await click(el, 'Submit');
  const replacement = question({ x: { type: 'string', default: 'b' } }, [], { toolCallId: null });
  await act(async () => root.render(h(AcpFormCard, { key: replacement.id, question: replacement, threadId: 'chat', readOnly: false })));
  await act(async () => finish({ status: 'failed', error: 'old failure' }));
  assert.doesNotMatch(el.textContent!, /old failure/);
  assert.equal((el.querySelector('input') as HTMLInputElement).value, 'b');
  questions = [q, replacement];
  await act(async () => root.render(h(AcpQuestions, { threadId: 'chat', readOnly: false })));
  assert.equal(el.querySelectorAll('section').length, 2);
});

test('numeric drafts reject precision loss, preserve decimal values, and optional choice can be unset', async () => {
  const q = question({ n: { type: 'number', default: 0.5 }, integer: { type: 'integer' }, choice: { type: 'string', enum: ['a'] } });
  const { el } = await render(q);
  const inputs = el.querySelectorAll('input');
  await input(inputs[1], '9007199254740991.1');
  await click(el, 'Submit');
  assert.equal(sent.length, 0);
  await input(inputs[1], '');
  await input(inputs[0], '0.12345678901234567');
  await click(el, 'Submit');
  assert.equal(sent.length, 0);
  await input(inputs[0], '0.125');
  await input(el.querySelector('select'), 'v:a');
  await input(el.querySelector('select'), '');
  await click(el, 'Submit');
  assert.deepEqual({ ...sent[0][2].content }, { n: 0.125 });
  const def = await render(question({ n: { type: 'number', default: 0.5 } }));
  await click(def.el, 'Submit');
  assert.equal(sent.at(-1)[2].content.n, 0.5);
});

test('the explicitly bounded per-window draft cache retains recent edits without ever submitting them', async () => {
  const first = question({ x: { type: 'string' } });
  const { el, root } = await render(first);
  await input(el.querySelector('input'), 'old');
  for (let i = 0; i < 129; i++) {
    const q = question({ x: { type: 'string' } });
    await act(async () => root.render(h(AcpFormCard, { key: q.id, question: q, threadId: 'chat', readOnly: false })));
    await input(el.querySelector('input'), `draft-${i}`);
  }
  assert.equal(sent.length, 0);
  await act(async () => root.render(h(AcpFormCard, { key: first.id, question: first, threadId: 'chat', readOnly: false })));
  assert.equal((el.querySelector('input') as HTMLInputElement).value, '');
});

test('numeric drafts reject underflow and subnormal rounding, retain input, and still allow cancellation', async () => {
  for (const raw of ['1e-400', '-1e-400', '2e-324', '3e-324', '-3e-324', '1.2345e-320', '1e400']) {
    const q = question({ n: { type: 'number' } }, ['n']);
    const { el } = await render(q);
    await input(el.querySelector('input'), raw);
    const before = sent.length;
    await click(el, 'Submit');
    assert.equal(sent.length, before, `wrong native answer for ${raw}: ${JSON.stringify(sent.at(-1)?.[2])}`);
    assert.equal((el.querySelector('input') as HTMLInputElement).value, raw);
    await click(el, 'Cancel');
    assert.deepEqual(sent.at(-1)[2], { action: 'cancel' });
  }
  for (const [raw, expected] of [
    ['0e-400', 0],
    ['-0.000e+999999999999999999999', 0],
    ['5e-324', 5e-324],
    ['-5e-324', -5e-324],
    ['1e-323', 1e-323],
    ['0.0000001', 1e-7],
    ['1.2500e+2', 125],
  ] as const) {
    const { el } = await render(question({ n: { type: 'number' } }, ['n']));
    await input(el.querySelector('input'), raw);
    await click(el, 'Submit');
    assert.equal(sent.at(-1)[2].action, 'accept');
    assert.equal(sent.at(-1)[2].content.n === expected, true);
  }
});

test('exact equivalent decimal spellings and integral exponents retain their numeric meaning', async () => {
  for (const [raw, expected, type] of [
    ['1.0000000000000000', 1, 'number'],
    ['10.00000000000000E-1', 1, 'number'],
    ['9007199254740991.00000', Number.MAX_SAFE_INTEGER, 'number'],
    ['1e0', 1, 'integer'],
    ['1.000', 1, 'integer'],
  ] as const) {
    const { el } = await render(question({ n: { type } }, ['n']));
    await input(el.querySelector('input'), raw);
    const before = sent.length;
    await click(el, 'Submit');
    assert.equal(sent.length, before + 1, raw);
    assert.equal(sent.at(-1)[2].content.n, expected);
  }
});

test('supported numeric defaults can be submitted unchanged without a narrower renderer precision limit', async () => {
  const expected = 0.1234567890123456;
  const { el } = await render(question({ n: { type: 'number', default: expected } }, ['n']));
  await click(el, 'Submit');
  assert.equal(sent.length, 1);
  assert.equal(sent[0][2].content.n, expected);
});
