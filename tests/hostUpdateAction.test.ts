// The Update action a machine chat shows beside a sentence that asks for the Host to be updated (src/components/host/HostUpdateAction.tsx, src/lib/machineStatus.ts hostUpdateLine): the machine row's own button where the row's Update works, the row's words for a newer Host or a machine added by command, nothing for a sentence that does not ask or a Host that is fine.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import './support/dom.ts';
import { $, $$, click, mount } from './support/composer-kit.ts';
import { mockSource } from './support/stubs.ts';
import { useFakeNative } from './support/ports/native.ts';

let machines: any[] = [];
const calls: any[] = [];
let updateFails = false;
const toasts: any[] = [];
mockSource('src/lib/hostMachines.ts', { useHostMachines: () => ({ machines }) });
mockSource('src/store/core.ts', { toast: (...a: any[]) => void toasts.push(a) });
const { createElement: h } = await import('react');
const { HostUpdateAction } = await import('../src/components/host/HostUpdateAction.tsx');
const { asksHostUpdate, hostUpdateLine } = await import('../src/lib/machineStatus.ts');
const { MachineNotice } = await import('../src/components/panels/MachineFolderNote.tsx');

const machine = (o: object = {}) => ({
  id: 'ssh:box',
  name: 'Box',
  status: 'online',
  note: '',
  signin: null,
  capabilities: { iab: false, cu: false },
  agents: [],
  installable: [],
  lastSeen: null,
  localNetwork: 'unknown',
  waitingForLogin: null,
  ...o,
});
const SAID = 'Update the Host on that machine.';

test('which sentences ask for an update', () => {
  for (const t of [
    SAID,
    'Update Host on that machine to use this Mac’s sign-in.',
    'Update Box to switch agents.',
    'The host cannot do this safely yet (it lacks logins). Update it.',
    'The host cannot do this safely yet (it lacks logins). Update it',
  ])
    assert.equal(asksHostUpdate(t), true, t);
  for (const t of ['That folder is not on this machine.', '', null, undefined]) assert.equal(asksHostUpdate(t), false, String(t));
});

test('the row’s Host-update line, or none when the machine is not in that state', () => {
  assert.equal(hostUpdateLine(machine() as any), null);
  assert.equal(hostUpdateLine(machine({ status: 'offline' }) as any), null);
  assert.deepEqual(hostUpdateLine(machine({ hostStale: true }) as any)?.update, { label: 'Update' });
});

test('an older Host: the row’s Update button, which updates that machine; a refusal is the row’s toast', async (t) => {
  useFakeNative(t, {
    host: {
      update: async (id: string) => {
        calls.push(id);
        if (updateFails) throw new Error('No ssh');
      },
    },
  });
  machines = [machine({ hostStale: true })];
  calls.length = 0;
  const view = await mount(h(HostUpdateAction, { hostId: 'ssh:box', text: SAID }));
  const b = $('button')!;
  assert.equal(b.getAttribute('aria-label'), 'Update the Host on Box');
  await click(b);
  assert.deepEqual(calls, ['ssh:box']);
  updateFails = true;
  await click($('button')!);
  assert.equal(toasts.at(-1)?.[1], 'error');
  updateFails = false;
  await view.unmount();
});

test('a failed update offers Try again, as the row does', async () => {
  machines = [machine({ hostStale: true, update: 'failed', updateError: 'No ssh' })];
  const view = await mount(h(HostUpdateAction, { hostId: 'ssh:box', text: SAID }));
  assert.equal($('button')!.textContent, 'Try again');
  await view.unmount();
});

test('a newer Host, a machine added by command, an update under way: the row’s words, no button', async () => {
  const words = async (m: object) => {
    machines = [machine(m)];
    const view = await mount(h(HostUpdateAction, { hostId: 'ssh:box', text: SAID }));
    const note = $('.host-update-note');
    const out = { note: note?.textContent, title: note?.getAttribute('title'), buttons: $$('button').length };
    await view.unmount();
    return out;
  };
  assert.deepEqual(await words({ hostNewer: true }), { note: 'Host is newer · Update MoPilot', title: null, buttons: 0 });
  machines = [machine({ id: 'relay:x', hostStale: true })];
  const view = await mount(h(HostUpdateAction, { hostId: 'relay:x', text: SAID }));
  assert.equal($('.host-update-note')!.textContent, 'Host is out of date · Update it on the machine');
  assert.equal($('.host-update-note')!.getAttribute('title'), 'No ssh from here. Run the update command on the machine.');
  assert.equal($$('button').length, 0);
  await view.unmount();
  assert.equal((await words({ hostStale: true, update: 'running' })).note, 'Updating Host…');
});

test('nothing for a sentence that does not ask, a Host that is up to date, or a machine not listed', async () => {
  machines = [machine({ hostStale: true })];
  for (const [id, text] of [
    ['ssh:box', 'That folder is not on this machine.'],
    ['ssh:gone', SAID],
  ] as const) {
    const view = await mount(h(HostUpdateAction, { hostId: id, text }));
    assert.equal(view.host.innerHTML, '', text);
    await view.unmount();
  }
  machines = [machine()];
  const view = await mount(h(HostUpdateAction, { hostId: 'ssh:box', text: SAID }));
  assert.equal(view.host.innerHTML, '');
  await view.unmount();
});

test('a panel notice carries the action only when it knows the machine', async () => {
  machines = [machine({ hostStale: true })];
  const withHost = await mount(h(MachineNotice, { text: SAID, hostId: 'ssh:box' }));
  assert.equal($$('button').length, 1);
  await withHost.unmount();
  const without = await mount(h(MachineNotice, { text: SAID }));
  assert.equal($$('button').length, 0);
  await without.unmount();
});
