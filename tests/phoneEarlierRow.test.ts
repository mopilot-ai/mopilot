// The row above a chat's first message: a quiet centered line (not a full-width button), its loading and error states, and where the chat starts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { act, createElement, createRoot } from './support/phone/component-kit';

const rowPath = '../mobile/src/components/EarlierRow';
const { EarlierRow } = await import(rowPath);
const styleOf = (el: Element | null | undefined) => JSON.parse(el?.getAttribute('data-style') ?? '{}');

async function mount(props: Record<string, unknown>) {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  await act(async () =>
    root.render(createElement(EarlierRow, { more: true, omitted: false, busy: false, error: null, load: () => {}, ...props })),
  );
  return {
    host,
    done: async () => {
      await act(async () => root.unmount());
      host.remove();
    },
  };
}

test('Load earlier messages is a quiet centered text row, 44 pt tall, with no box of its own', async () => {
  let loads = 0;
  const v = await mount({ load: () => loads++ });
  const button = v.host.querySelector('button[aria-label="Load earlier messages"]') as HTMLButtonElement;
  const row = styleOf(button);
  assert.equal(row.minHeight, 44);
  assert.equal(row.alignItems, 'center');
  assert.equal(row.backgroundColor, undefined, 'no filled button');
  assert.equal(row.borderWidth, undefined);
  const text = [...v.host.querySelectorAll('span')].find((n) => n.textContent === 'Load earlier messages');
  assert.equal(styleOf(text).textAlign, 'center');
  await act(async () => button.click());
  assert.equal(loads, 1);
  await v.done();
});

test('while a page loads the row says so, is disabled and reads busy; an error shows above it', async () => {
  const v = await mount({ busy: true, error: 'Could not load.' });
  const button = v.host.querySelector('button[aria-label="Loading earlier messages"]') as HTMLButtonElement;
  assert.equal(button.disabled, true);
  assert.equal(button.textContent, 'Loading…');
  assert.match(v.host.textContent!, /Could not load\./);
  await v.done();
});

test('with nothing earlier the row says where the chat starts, centered, and is not a button', async () => {
  const start = await mount({ more: false });
  assert.equal(start.host.querySelector('button'), null);
  const line = [...start.host.querySelectorAll('span')].find((n) => n.textContent === 'This is the start of the chat.');
  assert.equal(styleOf(line).textAlign, 'center');
  await start.done();
  const kept = await mount({ more: false, omitted: true });
  assert.match(kept.host.textContent!, /Earlier messages are only in MoPilot on your computer\./);
  await kept.done();
});
