// Installed-harness settings navigation, individual destinations and live detection transitions.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { openSettingsSection } from './e2e/fixtures/settings.ts';
import {
  setup,
  calls,
  ctl,
  resetCtl,
  defaultState,
  useStore,
  render,
  click,
  text,
  button,
  setValue,
  flush,
} from './support/settings-harness.ts';
await setup();
const React = await import('react');
const { createElement: h } = React;
const { Settings } = await import('../src/components/pages/Settings.tsx');
beforeEach(() => {
  resetCtl();
  useStore.setState(defaultState(), true);
});

test('E2E setup lookup selects the visible label of real Settings rows with named harness icons', async () => {
  ctl.status.codex = { state: 'missing' };
  ctl.status.claude = { state: 'missing' };
  const v = await render(h(Settings.Nav));
  const nav = v.host.querySelector('.settings-nav')!;
  const rows = () => [...nav.querySelectorAll<HTMLElement>('.side-row')];
  const page = {
    getByText: (label: string, options: { exact: boolean }) => {
      assert.equal(options.exact, true);
      return { label };
    },
    locator: (selector: string) => {
      assert.equal(selector, '.settings-nav');
      return {
        getByRole: (role: string, options: { name: string; exact: boolean }) => {
          assert.equal(options.exact, true);
          if (role === 'textbox') return { fill: (value: string) => setValue(nav.querySelector('input')!, value) };
          return {
            click: async () => {
              const found = rows().find(
                (row) => `${row.querySelector('[aria-label]')?.getAttribute('aria-label')} ${text(row)}` === options.name,
              );
              assert.ok(found, `no exact accessible button name ${options.name}`);
              await click(found);
            },
          };
        },
        locator: (rowSelector: string) => {
          // the page found by its name, which has no hint (#1869)
          assert.equal(rowSelector, '.side-row:not(.has-hint)');
          return {
            filter: ({ has }: { has: { label: string } }) => ({
              click: async () => {
                const found = rows()
                  .filter((row) => !row.classList.contains('has-hint'))
                  .find((row) => text(row.querySelector('.side-row-label')) === has.label)!;
                assert.ok(found);
                assert.equal(found.querySelector('[aria-label]')?.getAttribute('aria-label'), has.label);
                await click(found);
              },
            }),
          };
        },
      };
    },
  };
  for (const section of ['codex', 'claude']) {
    await openSettingsSection(page as any, section);
    assert.deepEqual(calls.at(-1), ['navigate', { name: 'settings', section }]);
    assert.equal((nav.querySelector('input') as HTMLInputElement).value, '');
  }
  await v.unmount();
});

test('the default harness sidebar lists installed families and each installed ACP harness, and updates live', async () => {
  ctl.status.codex = { state: 'missing' };
  ctl.status.claude = { state: 'signin' };
  useStore.setState({
    basicHarnesses: [
      { id: 'gemini', label: 'Gemini CLI', state: 'admitted' },
      { id: 'kimi:custom', label: 'Kimi Code', state: 'signin' },
      { id: 'qwen', label: 'Qwen Code', state: 'unsupported' },
      { id: 'off', label: 'Disabled', state: 'off' },
      { id: 'checking', label: 'Checking', state: 'checking' },
      { id: 'missing', label: 'Absent', state: 'missing' },
    ],
  });
  const v = await render(h(Settings.Nav));
  const labels = () => [...v.host.querySelectorAll('.sidebar-section')].find((e) => text(e.querySelector('.side-label')) === 'Harnesses')!;
  assert.deepEqual([...labels().querySelectorAll('.side-row-label')].map(text), [
    'All agents',
    'Claude Code',
    'Gemini CLI',
    'Kimi Code',
    'Qwen Code',
    'Disabled',
    'Checking',
  ]);
  const search = v.host.querySelector('input')!;
  await setValue(search, 'Gemini');
  assert.ok(button(v.host, 'Gemini CLI'));
  await setValue(search, '');
  await click(button(v.host, 'All agents'));
  assert.deepEqual(calls.at(-1), ['navigate', { name: 'settings', section: 'harnesses' }]);
  await click(button(v.host, 'Kimi Code'));
  assert.deepEqual(calls.at(-1), ['navigate', { name: 'settings', section: 'other-harnesses', tab: 'harness:kimi:custom' }]);
  useStore.setState({ route: { name: 'settings', section: 'other-harnesses', tab: 'harness:kimi:custom' } });
  await flush();
  assert.equal(text(v.host.querySelector('.side-row.selected')), 'Kimi Code');
  await setValue(search, 'ACP');
  assert.equal(v.host.querySelector('.side-row.selected'), null, 'the catalog search hit does not select an individual harness');
  await setValue(search, '');
  // A change in installation state updates the list without reopening Settings.
  ctl.status.codex = { state: 'ready' };
  ctl.status.claude = { state: 'missing' };
  useStore.setState({ basicHarnesses: [] });
  await flush();
  assert.deepEqual([...labels().querySelectorAll('.side-row-label')].map(text), ['All agents', 'Codex']);
  await React.act(() => useStore.setState({ route: { name: 'settings', section: 'codex', tab: 'extensions' } }));
  assert.equal(text(v.host.querySelector('.side-row.selected')), 'Codex', 'a harness sub-section still selects its harness');
  const input = v.host.querySelector('input')!;
  await setValue(input, 'Claude');
  assert.ok(button(v.host, 'Claude Code'), 'search can still open setup for an absent harness');
  await v.unmount();
});

test('an ACP sidebar destination has its own heading and passes the entire opaque id to its settings', async () => {
  useStore.setState({
    route: { name: 'settings', section: 'other-harnesses', tab: 'harness:custom:a' },
    basicHarnesses: [
      { id: 'unrelated', label: 'Another', state: 'admitted' },
      { id: 'custom:a', label: 'Custom harness', state: 'admitted' },
    ],
  });
  const v = await render(h(Settings, { section: 'other-harnesses' }));
  // an installed one's page gives its own title in its header (#1871): Settings adds none
  assert.equal(v.host.querySelector('h1'), null);
  assert.equal(JSON.parse(v.host.querySelector('[data-stub=OtherHarnesses]')!.getAttribute('data-props')!).harnessId, 'custom:a');
  useStore.setState({ basicHarnesses: [{ id: 'custom:a', label: 'Custom harness', state: 'missing' }] });
  await flush();
  assert.equal(text(v.host.querySelector('h1')), 'Custom harness', 'a removed harness retains its own installation page');
  assert.equal(JSON.parse(v.host.querySelector('[data-stub=OtherHarnesses]')!.getAttribute('data-props')!).harnessId, 'custom:a');
  useStore.setState({ route: { name: 'settings', section: 'other-harnesses', tab: 'legacy' } });
  await flush();
  assert.equal(text(v.host.querySelector('h1')), 'Other agents');
  await v.unmount();
});
