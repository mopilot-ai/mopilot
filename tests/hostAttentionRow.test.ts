// The sidebar keeps the Host badge independent of the attention line and exposes both to assistive technology.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import './support/dom.ts';
import { act, createElement as h } from 'react';
import { createRoot } from 'react-dom/client';
import type { Thread } from '../src/store/types.ts';
import { sidebarRowKit } from './support/sidebar-row-kit.ts';

const kit = await sidebarRowKit();
const { ThreadRow } = kit;

test('remote location remains visible as attention clears, with the host name available in details', async () => {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const chat = { id: 'c1', name: 'Fix flaky login', cwd: '/repo', updatedAt: 1 } as Thread;
  const row = () => host.querySelector('.thread-row')!;
  const description = () => document.getElementById(row().getAttribute('aria-describedby')!)?.textContent;
  const show = (startedBy?: string) => act(async () => root.render(h(ThreadRow, { thread: { ...chat }, active: false, startedBy })));
  try {
    kit.machineLine = { id: 'ssh:box', name: 'build-box', word: 'Needs you' };
    await show('Parent chat');
    assert.equal(host.querySelector('.thread-row.has-sub .side-row-sub')?.textContent, 'Needs you');
    assert.equal(row().querySelector('.side-row-name')?.textContent, 'Fix flaky login');
    assert.ok(row().querySelector('.host-mark[title="On build-box"] .lucide-square-terminal'));
    assert.equal(description(), 'Started by the agent from Parent chat. On build-box. Needs you');

    kit.machineLine = { ...kit.machineLine, name: 'Studio', word: null };
    await show();
    assert.equal(host.querySelector('.has-sub'), null);
    assert.equal(host.querySelector('.side-row-sub'), null);
    assert.ok(row().querySelector('.host-mark[title="On Studio"] .lucide-square-terminal'));
    assert.equal(description(), 'On Studio');

    kit.machineLine = { id: 'this-mac-host', name: 'This Mac · keeps running', word: 'Paused' };
    await show();
    assert.ok(row().querySelector('.host-mark .lucide-laptop'));
    assert.equal(host.querySelector('.side-row-sub')?.textContent, 'Paused');

    kit.machineLine = null;
    await show();
    assert.equal(host.querySelector('.has-sub'), null);
    assert.equal(row().querySelector('.host-mark'), null);
    assert.equal(row().getAttribute('aria-describedby'), null);
  } finally {
    await act(async () => root.unmount());
    host.remove();
  }
});
