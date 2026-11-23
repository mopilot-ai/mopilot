// The Switch host dialog after a machine that did not answer (Remote Run #5197): the refusal says so in place and the one button reads Try again, which asks the machine again; any other refusal keeps "Switch host".
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { act, createElement } from 'react';
import './support/dom.ts';
import { $, $$, click, mockTsx, mount } from './support/composer-kit.ts';

mockTsx(new URL('../src/components/composer/HostFolderPicker.tsx', import.meta.url), { HostFolderPicker: () => null });
const { SwitchHostDialog } = await import('../src/components/composer/SwitchHostDialog.tsx');

const MACHINES = [
  { id: 'local', name: 'This Mac', status: 'online', note: '' },
  { id: 'dev', name: 'dev-vm', status: 'online', note: 'SSH · Codex' },
];
const refusal = (code: string) => Object.assign(new Error('raw'), { code });
const primary = () => $$('.acct-dialog-actions button').at(-1)!;
const type = (el: HTMLInputElement, value: string) =>
  act(async () => {
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!.call(el, value);
    el.dispatchEvent(new window.Event('input', { bubbles: true }));
  });

test('a machine that did not answer is asked again by the same press, now labelled Try again; another refusal keeps Switch host', async () => {
  const plans: string[] = [];
  let answer: 'unreachable' | 'other' | 'ok' = 'unreachable';
  const m = await mount(
    createElement(SwitchHostDialog, {
      chatId: 'c1',
      project: '/work/app',
      ownerId: 'local',
      ownerLost: false,
      machines: MACHINES,
      turnRunning: false,
      onClose: () => undefined,
      onContinue: async () => undefined,
      onPlan: async (req: { targetHostId: string }) => {
        plans.push(req.targetHostId);
        if (answer === 'unreachable') throw refusal('host_unreachable');
        if (answer === 'other') throw refusal('directory_missing');
        return { plan: null };
      },
    } as any),
  );
  try {
    await type($('input[aria-label="Folder on the host"]') as HTMLInputElement, '/srv');
    assert.equal(primary().textContent, 'Switch host', 'nothing refused yet');
    await click(primary());
    assert.match($('.acct-dialog-hint').textContent!, /isn't reachable/);
    assert.equal(primary().textContent, 'Try again');
    assert.equal((primary() as HTMLButtonElement).disabled, false, 'ready to ask again');
    // the machine answers a different refusal: the label goes back to what the press does
    answer = 'other';
    await click(primary());
    assert.equal(plans.length, 2, 'the press asked the machine again');
    assert.equal(primary().textContent, 'Switch host');
    // and it answers: the switch goes on
    answer = 'ok';
    await click(primary());
    assert.equal(plans.length, 3);
  } finally {
    await m.unmount();
  }
});
