// Focused mobile component scenarios with native boundaries replaced by test controls.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { act, createElement, createRoot, click, flush, inputText, openCodeEntry } from './support/phone/component-kit';
const cardModulePath = '../mobile/src/components/RequestCard';
const pairingModulePath = '../mobile/src/screens/Pairing';
const { RequestCard } = await import(cardModulePath);
const { Pairing } = await import(pairingModulePath);

test('request forms retain multiple choices and typed values until answered', async () => {
  const answers: any[] = [];
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const card = {
    title: 'Form',
    detail: 'Detail',
    inApp: true,
    url: 'https://example.test',
    questions: [{ id: 'q', header: 'Question', multiSelect: true, isOther: true, options: [{ label: 'A' }, { label: 'B' }] }],
    schema: {
      properties: {
        choice: { enum: ['x', 'y'], enumLabels: ['Ex', 'Why'] },
        flag: { type: 'boolean' },
        note: { type: 'string' },
        count: { type: 'integer' },
      },
    },
    choices: [{ key: 'submit', label: 'Submit' }],
  };
  await act(async () =>
    root.render(
      createElement(RequestCard, {
        card,
        answer: async (key: string, values: any) => {
          answers.push({ key, values });
          return true;
        },
      }),
    ),
  );
  await click('A');
  await click('B');
  await click('✓ A');
  await inputText('Your answer', 'custom');
  await click('Ex');
  await click('Yes');
  await inputText('note', 'hello');
  await inputText('count', 'oops');
  await inputText('count', '42');
  await click('Submit');
  assert.deepEqual(answers[0], { key: 'submit', values: { q: ['custom'], choice: 'x', flag: true, note: 'hello', count: 42 } });
  assert.match(host.textContent!, /Finish this request/);
  await act(async () => root.unmount());
  host.remove();
});

test('pairing camera and pair failures remain retryable', async () => {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  let granted = true;
  let fail = false;
  const sent: any[] = [];
  (globalThis as any).__phoneCamera = async () => {
    if (fail) throw Error('camera failure');
    return { granted };
  };
  const runtime: any = {
    pair: async (...args: any[]) => {
      sent.push(args);
      if (fail) throw Error('pair failure');
    },
  };
  await act(async () => root.render(createElement(Pairing, { start: 'scan', runtime, back: () => {} })));
  await flush();
  await click('Camera preview');
  assert.deepEqual(sent[0], ['scanned code', 'Phone'], 'a scan pairs at once with the phone name');
  fail = true;
  await click('Paste code instead');
  await inputText('Paste pairing code', 'typed code');
  await click('Advanced');
  await inputText('Phone name', 'Pocket');
  await click('Connect');
  assert.deepEqual(sent[1], ['typed code', 'Pocket']);
  assert.match(host.textContent!, /Couldn't pair\. Try again\./);
  await click('Scan instead');
  await flush();
  assert.match(host.textContent!, /The camera could not start/);
  fail = false;
  granted = true;
  await click('Scan again');
  assert.ok(host.querySelector('button')?.textContent?.includes('Camera preview') || /Camera preview/.test(host.textContent!));
  await act(async () => root.unmount());
  host.remove();
});

test('single question option and dark mode use the component controls', async () => {
  (globalThis as any).__phoneDark = true;
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const sent: any[] = [];
  await act(async () =>
    root.render(
      createElement(RequestCard, {
        card: {
          title: 'Q',
          questions: [{ id: 'q', question: 'Choose', options: [{ label: 'A' }] }],
          choices: [{ key: 'submit', label: 'Submit' }],
        },
        answer: async (_key: string, values: any) => {
          sent.push(values);
          return true;
        },
      }),
    ),
  );
  await click('A');
  await click('Submit');
  assert.deepEqual(sent[0], { q: ['A'] });
  await act(async () => root.unmount());
  host.remove();
  (globalThis as any).__phoneDark = false;
});

test('dark fields and non-string camera failures remain readable', async () => {
  (globalThis as any).__phoneDark = true;
  (globalThis as any).__phoneCamera = async () => {
    throw 'camera denied';
  };
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  await act(async () =>
    root.render(
      createElement(Pairing, {
        start: 'scan',
        runtime: {
          pair: async () => {
            throw 'pair denied';
          },
        } as any,
        back: () => {},
      }),
    ),
  );
  await flush();
  assert.match(host.textContent!, /The camera could not start/);
  await openCodeEntry();
  await inputText('Paste pairing code', 'code');
  await click('Connect');
  assert.match(host.textContent!, /Couldn't pair\. Try again\./);
  await act(async () => root.unmount());
  host.remove();
  (globalThis as any).__phoneDark = false;
});

test('pending form cannot submit twice and enum values without labels remain selectable', async () => {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  let resolve: (v: boolean) => void = () => {};
  let calls = 0;
  const card = { title: 'Q', schema: { properties: { answer: { enum: ['first'] } } }, choices: [{ key: 'ok', label: 'Submit' }] };
  await act(async () =>
    root.render(
      createElement(RequestCard, {
        card,
        answer: async () => {
          calls++;
          return new Promise<boolean>((r) => {
            resolve = r;
          });
        },
      }),
    ),
  );
  await click('first');
  const b = [...document.querySelectorAll('button')].find((x) => x.textContent === 'Submit')!;
  await act(async () => {
    b.click();
    b.click();
  });
  assert.equal(calls, 1);
  await act(async () => resolve(true));
  await act(async () => root.unmount());
  host.remove();
});
