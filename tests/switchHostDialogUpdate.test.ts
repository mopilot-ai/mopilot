// The Switch host dialog's refusals that say the target's Host is too old (src/components/composer/SwitchHostDialog.tsx): the machine row's Update beside the sentence for an older Host, nothing for a refusal about something else or a Host that is current.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { act, createElement } from 'react';
import './support/dom.ts';
import { $, $$, click, mount } from './support/composer-kit.ts';
import { mockSource } from './support/stubs.ts';

let listed: any[] = [];
mockSource('src/components/pages/settings/Connections.tsx', {
  openSshTerminal: () => {
    throw new Error('The Host update dialog must not open a terminal.');
  },
});
mockSource('src/lib/hostMachines.ts', { useHostMachines: () => ({ machines: listed }) });
const { SwitchHostDialog } = await import('../src/components/composer/SwitchHostDialog.tsx');

const FLEET = [
  { id: 'local', name: 'This Mac', status: 'online', note: '' },
  { id: 'dev', name: 'dev-vm', status: 'online', note: 'SSH · Codex' },
];
const type = (el: HTMLInputElement, value: string) =>
  act(async () => {
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!.call(el, value);
    el.dispatchEvent(new window.Event('input', { bubbles: true }));
  });

test('a refusal that says the Host is too old carries the row’s Update for that machine; a refusal about something else carries none', async () => {
  for (const [code, stale, buttons] of [
    ['harness_not_configured', true, 1],
    ['harness_not_configured', false, 0],
    ['agent_missing', true, 0],
  ] as const) {
    listed = [{ id: 'dev', name: 'dev-vm', status: 'online', agents: [], hostStale: stale }];
    let attempt = 0;
    const m = await mount(
      createElement(SwitchHostDialog, {
        chatId: 'c1',
        project: '/work/app',
        ownerId: 'local',
        ownerLost: false,
        machines: FLEET,
        agent: 'codex',
        turnRunning: false,
        onContinue: async () => {
          if (attempt++ === 0) throw Object.assign(new Error('raw'), { code });
        },
        onClose: () => undefined,
      } as any),
    );
    try {
      await type($('input[aria-label="Folder on the host"]') as HTMLInputElement, '/srv/app');
      await click($$('.acct-dialog-actions button').find((b) => /Switch host/.test(b.textContent!))!);
      const alert = $('[role=alert]');
      assert.equal($$('button', alert).length, buttons, `${code} ${stale}`);
      if (buttons) assert.equal($('button', alert).getAttribute('aria-label'), 'Update the Host on dev-vm');
    } finally {
      await m.unmount();
      listed = [];
    }
  }
});

test('the same on the carry question: a refusal after Carry changes shows there with the row’s Update for an older Host', async () => {
  for (const [stale, buttons] of [
    [true, 1],
    [false, 0],
  ] as const) {
    listed = [{ id: 'dev', name: 'dev-vm', status: 'online', agents: [], hostStale: stale }];
    const m = await mount(
      createElement(SwitchHostDialog, {
        chatId: 'c1',
        project: '/work/app',
        ownerId: 'local',
        ownerLost: false,
        machines: FLEET,
        agent: 'codex',
        turnRunning: false,
        onPlan: async () => ({ plan: { untracked: [], skipped: [], files: 1, unpushed: 0, remote: 'origin' } }),
        onContinue: async () => {
          throw Object.assign(new Error('raw'), { code: 'harness_not_configured' });
        },
        onClose: () => undefined,
      } as any),
    );
    try {
      await type($('input[aria-label="Folder on the host"]') as HTMLInputElement, '/srv/app');
      await click($$('.acct-dialog-actions button').find((b) => /Switch host/.test(b.textContent!))!);
      await click($$('.acct-dialog-actions button').find((b) => /Carry changes/.test(b.textContent!))!);
      const alert = $('[role=alert]');
      assert.match(alert.textContent!, /too old/);
      assert.equal($$('button', alert).length, buttons, `stale ${stale}`);
      if (buttons) assert.equal($('button', alert).getAttribute('aria-label'), 'Update the Host on dev-vm');
    } finally {
      await m.unmount();
      listed = [];
    }
  }
});
