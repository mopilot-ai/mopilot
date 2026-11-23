// Settings → Connections → Linear (src/components/pages/settings/LinearConnection.tsx): the user pastes their own key, which goes to main and is never shown again; connected, it shows the key's last four characters and disconnects.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import './support/dom.ts';
import { createElement } from 'react';
import { render, click, type, flush } from './support/shell-chrome-kit.ts';
import { installNativeStub } from './support/ports/native.ts';
import { stubStore } from './support/stubs.ts';

const toasts: unknown[][] = [];
const calls: unknown[][] = [];
let status = { connected: false, last4: null as string | null };
let connect: (key: string) => any = async () => ({ ok: true, name: 'Pat' });
let readStatus: () => Promise<typeof status> = async () => status;
let disconnectImpl: () => Promise<unknown> = async () => ((status = { connected: false, last4: null }), { ok: true });
stubStore({ toast: (...a: unknown[]) => toasts.push(a) });
installNativeStub({
  linear: {
    status: () => readStatus(),
    connect: async (key: string) => {
      calls.push(['connect', key]);
      const r = await connect(key);
      if (r.ok) status = { connected: true, last4: key.slice(-4) };
      return r;
    },
    disconnect: () => (calls.push(['disconnect']), disconnectImpl()),
  },
});
const { LinearConnection } = await import('../src/components/pages/settings/LinearConnection.tsx');

test('pasting a key connects through main; connected shows its last four characters, and Disconnect forgets it', async () => {
  const v = await render(createElement(LinearConnection));
  await flush();
  const input = () => v.host.querySelector('input[aria-label="Linear API key"]') as HTMLInputElement;
  assert.equal(input().type, 'password');
  await type(input(), ' lin_api_abcd1234 ');
  await click(v.host.querySelector('.btn.primary'));
  await flush();
  assert.deepEqual(calls, [['connect', 'lin_api_abcd1234']]);
  assert.deepEqual(toasts.at(-1), ['Connected to Linear as Pat', 'success']);
  assert.match(v.host.textContent ?? '', /API key ending in 1234/);
  await click(v.host.querySelector('.btn.sm'));
  await flush();
  assert.equal(input()?.value, '');
  await v.unmount();
});

test('a key Linear refuses, a connect that throws, and an unnamed account each say so', async () => {
  for (const [answer, said] of [
    [async () => ({ ok: false, error: 'Linear refused the API key.' }), ['Linear refused the API key.', 'error']],
    [async () => Promise.reject(new Error('down')), ["Couldn't connect Linear: down", 'error']],
    [async () => ({ ok: true, name: '' }), ['Connected to Linear', 'success']],
  ] as const) {
    status = { connected: false, last4: null };
    connect = answer as any;
    const v = await render(createElement(LinearConnection));
    await flush();
    await type(v.host.querySelector('input[aria-label="Linear API key"]'), 'lin_api_k');
    await click(v.host.querySelector('.btn.primary'));
    await flush();
    assert.deepEqual(toasts.at(-1), said);
    await v.unmount();
  }
});

test('a status that can’t be read, Enter to connect, and a disconnect that fails each behave', async () => {
  readStatus = () => Promise.reject(new Error('main is down'));
  const broken = await render(createElement(LinearConnection));
  await flush();
  assert.deepEqual(toasts.at(-1), ["Couldn't read the Linear connection: main is down", 'error']);
  assert.equal(broken.host.textContent, '');
  await broken.unmount();
  readStatus = async () => status;
  status = { connected: false, last4: null };
  connect = async () => ({ ok: true, name: 'Pat' });
  const v = await render(createElement(LinearConnection));
  await flush();
  const input = v.host.querySelector('input[aria-label="Linear API key"]') as HTMLInputElement;
  // Enter with nothing typed connects nothing
  const before = calls.length;
  input.dispatchEvent(new (window as any).KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  await flush();
  assert.equal(calls.length, before);
  await type(input, 'lin_api_wxyz');
  input.dispatchEvent(new (window as any).KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  await flush();
  assert.match(v.host.textContent ?? '', /ending in wxyz/);
  disconnectImpl = () => Promise.reject(new Error('gone'));
  await click(v.host.querySelector('.btn.sm'));
  await flush();
  assert.deepEqual(toasts.at(-1), ["Couldn't disconnect Linear: gone", 'error']);
  await v.unmount();
});
