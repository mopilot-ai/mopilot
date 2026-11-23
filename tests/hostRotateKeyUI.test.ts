// Settings › Connections › Rotate this Mac's key (src/components/pages/settings/HostRotateKey.tsx): hidden with no machines, asks first, runs, and says how many machines have the new key, which still have the old one, or what stopped it.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  setup,
  resetCtl,
  responses,
  calls,
  useStore,
  defaultState,
  render,
  click,
  button,
  text,
  flush,
} from './support/settings-harness.ts';

await setup();
await import('../src/lib/native/host.ts');
const { createElement: h } = await import('react');
const { HostMachines } = await import('../src/components/pages/settings/HostMachines.tsx');
const { rotateLines } = await import('../src/components/pages/settings/HostRotateKey.tsx');

const BOX = {
  id: 'ssh:box',
  name: 'build-box',
  status: 'online',
  note: 'SSH · Claude Code',
  capabilities: { iab: false, cu: false },
  agents: [],
  installable: [],
};
const results = (root: Element) => [...root.querySelectorAll('[aria-label="Key rotation result"] li')].map((li) => text(li));

beforeEach(() => {
  resetCtl();
  useStore.setState({ ...defaultState(), route: { name: 'settings', section: 'connections' } }, true);
  Object.assign(responses, {
    'host.access': true,
    'host.machines': () => Promise.resolve({ machines: [BOX], resolved: true }),
    'host.rotateKey': () => Promise.resolve({ machines: 1, pending: [] }),
  });
  calls.length = 0;
});

test('the lines of a result: how many machines have the new key, and each that still has the old one, by name', () => {
  assert.deepEqual(rotateLines({ machines: 1, pending: [] }, [BOX]), ['New key on 1 machine.']);
  assert.deepEqual(
    rotateLines(
      {
        machines: 2,
        pending: [
          { id: 'ssh:box', error: 'No answer.' },
          { id: 'ssh:gone', error: 'Asleep.' },
        ],
      },
      [BOX],
    ),
    [
      'New key on 4 machines; the old key is gone from 2.',
      'build-box still has the old key: No answer. Press again to retry.',
      'ssh:gone still has the old key: Asleep. Press again to retry.',
    ],
  );
});

test('no machines, no rotation to offer', async (t) => {
  responses['host.machines'] = () => Promise.resolve({ machines: [], resolved: true });
  const root = await render(h(HostMachines));
  t.after(() => root.unmount());
  await flush(5);
  assert.equal(root.host.textContent?.includes('Rotate this Mac’s key'), false);
});

test('it asks first; Cancel changes nothing; Rotate runs and says how many machines have the new key', async (t) => {
  const root = await render(h(HostMachines));
  t.after(() => root.unmount());
  await flush(5);
  const live = root.host.querySelector('[aria-label="Key rotation result"]');
  assert.ok(live, 'the announcement region exists before results arrive');
  assert.equal(live.getAttribute('aria-live'), 'polite');
  assert.equal(live.getAttribute('aria-atomic'), 'true');
  await click(button(root.host, 'Rotate this Mac’s key'));
  assert.match(text(root.host.querySelector('[aria-label="Rotate this Mac\'s key"]')), /Every machine must be online and up to date/);
  await click(button(root.host, 'Cancel'));
  assert.equal(calls.filter((c) => c[0] === 'host.rotateKey').length, 0);
  await click(button(root.host, 'Rotate this Mac’s key'));
  await click(button(root.host, 'Rotate'));
  await flush(5);
  assert.equal(calls.filter((c) => c[0] === 'host.rotateKey').length, 1);
  assert.deepEqual(results(root.host), ['New key on 1 machine.']);
});

test('a machine that did not drop the old key is named; a refusal is said as it is, with nothing changed', async (t) => {
  responses['host.rotateKey'] = () => Promise.resolve({ machines: 0, pending: [{ id: 'ssh:box', error: 'Asleep.' }] });
  const root = await render(h(HostMachines));
  t.after(() => root.unmount());
  await flush(5);
  await click(button(root.host, 'Rotate this Mac’s key'));
  await click(button(root.host, 'Rotate'));
  await flush(5);
  assert.deepEqual(results(root.host), [
    'New key on 1 machine; the old key is gone from 0.',
    'build-box still has the old key: Asleep. Press again to retry.',
  ]);
  responses['host.rotateKey'] = () =>
    Promise.reject(
      Object.assign(new Error('Every machine must be online, reached by ssh and up to date first: build-box.'), {
        code: 'rotation_blocked',
      }),
    );
  await click(button(root.host, 'Rotate this Mac’s key'));
  await click(button(root.host, 'Rotate'));
  await flush(5);
  assert.deepEqual(results(root.host), ['Every machine must be online, reached by ssh and up to date first: build-box.']);
});
