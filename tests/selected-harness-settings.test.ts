// Individual ACP harness settings: details, switching and installation recovery.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  store,
  ctl,
  calls,
  infos,
  OtherHarnesses,
  harness,
  ids,
  section,
  h,
  act,
  render,
  click,
  byText,
} from './support/other-harnesses-harness.ts';

/** The button that reads exactly this ("Sign in" is also the start of "Sign in again"). */
const exactButton = (root: ParentNode, text: string) =>
  [...root.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent === text) ?? null;
const tab = (host: HTMLElement, t: string) => click(host.querySelector(`[data-tab=${t}]`));
const groups = (host: HTMLElement) => [...host.querySelectorAll('section h3')].map((e) => e.textContent);

test('native model catalogs reach Settings without inventing configurable options', async () => {
  store.setState({
    prefs: {},
    basicHarnesses: [
      harness({
        id: 'one',
        label: 'One',
        catalog: { models: { availableModels: [{ modelId: 'a', name: 'Alpha' }, { modelId: 'b' }, { modelId: 'a', name: 'Alpha' }] } },
      }),
    ],
  });
  const v = await render(h(OtherHarnesses, { harnessId: 'one' }));
  assert.deepEqual(
    [...v.host.querySelectorAll('.model-chip')].map((e) => e.textContent),
    ['Alpha', 'b'],
  );
  await v.unmount();
});

test('a basic harness has a page in the frame Codex and Claude Code share: header, then Overview, Extensions, Advanced (#1871)', async () => {
  store.setState({
    prefs: {},
    basicHarnesses: [
      harness({
        id: 'one',
        label: 'One',
        authMethods: [{ id: 'web', name: 'Login with One' }],
        bin: '/bin/one',
        version: '1.2',
        catalog: {
          configOptions: [
            {
              id: 'm',
              category: 'model',
              type: 'select',
              currentValue: 'a',
              options: [{ value: 'a', name: 'Alpha' }, { value: 'b', name: 'Beta' }, { value: 'a', name: 'Alpha' }, { value: 'c' }],
            },
          ],
        },
      }),
      harness({ id: 'two', label: 'Two' }),
    ],
  });
  const v = await render(h(OtherHarnesses, { harnessId: 'one' }));
  // the header: its mark and name as the page title, its state, its version line and Re-check; no collapse control
  assert.equal(v.host.querySelector('h1')!.textContent, 'One');
  assert.match(v.host.querySelector('.harness-head-meta')!.textContent!, /^Ready/);
  assert.ok(v.host.querySelector('.harness-head [data-badge=one]'));
  assert.equal(v.host.querySelector('.harness-head [data-version-of]')!.getAttribute('data-version-of'), 'acp:one');
  assert.equal(v.host.querySelector('[aria-expanded]'), null);
  calls.length = 0;
  await click(byText(v.host.querySelector('.harness-head')!, 'Re-check'));
  assert.deepEqual(calls, [['recheck', 'one']]);
  // Overview: its account (signed in: sign in again), new chats, its models, what works
  assert.equal(v.host.querySelector('[data-tabs]')!.getAttribute('data-tabs'), 'overview');
  assert.deepEqual(groups(v.host), ['Account', 'Defaults']);
  assert.ok(byText(v.host, 'Sign in again'));
  assert.equal(v.host.querySelector('[data-row="New chats use"]')!.getAttribute('data-own'), 'acp:one');
  assert.equal(v.host.querySelector('[data-route]')!.getAttribute('data-route'), 'acp:one');
  assert.deepEqual(
    [...v.host.querySelectorAll('.model-chip')].map((e) => e.textContent),
    ['Alpha', 'Beta', 'c'],
  );
  assert.equal(v.host.querySelector('[data-works]')!.getAttribute('data-inline'), 'false');
  // Extensions: the MCP servers in its own settings
  await tab(v.host, 'extensions');
  assert.deepEqual(groups(v.host), ['MCP servers']);
  assert.equal(v.host.querySelector('[data-own-mcp]')!.getAttribute('data-own-mcp'), 'one');
  // Advanced: which CLI runs, by the registry's name for it, and a location set by hand
  infos['acp:one'] = { detect: { bins: ['one-cli'] } };
  await act(() => store.setState({ prefs: { acpBins: { one: '/my/one' } } }));
  await tab(v.host, 'advanced');
  const row = v.host.querySelector('[data-version-row]')!;
  assert.deepEqual(
    [
      row.getAttribute('data-version-row'),
      row.getAttribute('data-binpath'),
      row.getAttribute('data-bin'),
      row.getAttribute('data-version'),
    ],
    ['acp:one', 'one-cli', '/bin/one', '1.2'],
  );
  assert.match(row.textContent!, /\/my\/one/);
  calls.length = 0;
  await click(row.querySelector('[data-bin-set]'));
  assert.deepEqual(calls[0], ['prefs', { acpBins: { one: '/opt/bin/one-cli' } }]);
  delete infos['acp:one'];
  // another harness's page starts on its own Overview; with no models known yet it says when they show
  await v.rerender(h(OtherHarnesses, { harnessId: 'two' }));
  assert.equal(v.host.querySelector('h1')!.textContent, 'Two');
  assert.equal(v.host.querySelector('[data-tabs]')!.getAttribute('data-tabs'), 'overview');
  assert.equal(v.host.querySelector('[data-row="Models"] i')!.textContent, 'Listed after its first chat');
  // dozens of models: eight, then the rest on request
  const many = Array.from({ length: 11 }, (_, i) => ({ value: `m${i}`, name: `M${i}` }));
  await act(() =>
    store.setState({
      basicHarnesses: [
        harness({ id: 'two', label: 'Two', catalog: { configOptions: [{ id: 'm', category: 'model', type: 'select', options: many }] } }),
      ],
    }),
  );
  const chips = () => [...v.host.querySelectorAll('.model-chip')].map((e) => e.textContent);
  assert.deepEqual(chips().slice(-2), ['M7', '+3 more']);
  await click(byText(v.host, '+3 more'));
  assert.deepEqual(chips().slice(-2), ['M10', 'Show less']);
  await click(byText(v.host, 'Show less'));
  assert.equal(chips().length, 9);
  // removed: its own setup controls, to find it again
  await act(() => store.setState({ basicHarnesses: [harness({ id: 'two', label: 'Two', state: 'missing' })] }));
  assert.deepEqual(ids(v.host), ['two']);
  assert.equal(v.host.querySelector('h1'), null);
  assert.ok(byText(v.host, 'Set location…'));
  await v.rerender(h(OtherHarnesses, { harnessId: 'unknown' }));
  assert.ok(section(v.host, 'Available to install'));
  await v.unmount();
});

test("a basic harness's page says what it needs: signed out, checking, can't run, a sign-in waiting", async () => {
  ctl.loginFor = { 's:null': { command: ['s', 'login'], title: 's login' } };
  store.setState({
    prefs: { defaultHarness: 'acp:s' },
    basicSignIns: {},
    basicHarnesses: [harness({ id: 's', label: 'S', state: 'signin', reason: 'Sign in to S first', login: ['s', 'login'] })],
  });
  const v = await render(h(OtherHarnesses, { harnessId: 's' }));
  assert.equal(v.host.querySelector('.harness-head-warn')!.textContent, 'Sign in to S first');
  // the default though it can't run: still the choice, with what new chats start in instead
  assert.ok(v.host.querySelector('[data-row="New chats use"]'));
  assert.equal(v.host.querySelector('[data-works]'), null);
  // signing in is the primary action, and runs in a terminal on the page
  const btn = exactButton(v.host, 'Sign in')!;
  assert.equal(btn.className, 'btn-pill primary');
  await click(btn);
  assert.equal(v.host.querySelector('[data-term]')!.textContent, 's login');
  // the login stays open on another tab: switching tabs must not end it
  const term = v.host.querySelector('[data-term]');
  await tab(v.host, 'advanced');
  assert.equal(v.host.querySelector('[data-term]'), term);
  await tab(v.host, 'overview');
  await act(async () => ctl.exitTerm!());
  assert.equal(v.host.querySelector('[data-term]'), null);
  // one with no sign-in of its own needs setting up: Re-check once it is
  await act(() => store.setState({ basicHarnesses: [harness({ id: 's', label: 'S', state: 'signin', reason: null })] }));
  assert.match(v.host.querySelector('.harness-head-meta')!.textContent!, /Needs setup/);
  calls.length = 0;
  await click(byText(v.host.querySelector('section[data-group=Account]')!, 'Re-check'));
  assert.deepEqual(calls, [['recheck', 's']]);
  // checking: said plainly, and Re-check waits
  await act(() => store.setState({ prefs: {}, basicHarnesses: [harness({ id: 's', label: 'S', state: 'checking' })] }));
  assert.equal(v.host.querySelectorAll('.harness-head-meta')[1].textContent, 'Checking that it can run…');
  assert.equal((byText(v.host.querySelector('.harness-head')!, 'Re-check') as HTMLButtonElement).disabled, true);
  assert.equal(v.host.querySelector('[data-row="New chats use"]'), null, 'not offered while it cannot run');
  // a sign-in waiting on the browser
  await act(() =>
    store.setState({
      basicSignIns: { s: true },
      basicHarnesses: [harness({ id: 's', label: 'S', state: 'signin', authMethods: [{ id: 'web', name: 'Web' }] })],
    }),
  );
  assert.ok(v.host.querySelector('.harness-head [role=status]'));
  assert.ok(byText(v.host, 'Cancel'));
  await v.unmount();
  store.setState({ basicSignIns: {}, basicHarnesses: [], prefs: {} });
  ctl.loginFor = {};
});
