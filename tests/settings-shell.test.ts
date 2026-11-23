// Settings page shell: navigation, section routing and the shared building blocks.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
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
  buttons,
  row,
  pick,
  options,
  setValue,
  key,
  blur,
  flush,
  lastPrefs,
} from './support/settings-harness.ts';

await setup();
const React = await import('react');
const { createElement: h } = React;
const S = await import('../src/components/pages/Settings.tsx');
const {
  Settings,
  Group,
  Row,
  BinPathRow,
  Toggle,
  Select,
  Segmented,
  InlineCode,
  groupBy,
  EffortsSelect,
  SECTIONS,
  ACCENTS,
  SHORTCUT_ACTIONS,
} = S;

beforeEach(() => {
  resetCtl();
  useStore.setState(defaultState(), true);
});

test('every section has an icon and the exported lists are populated', () => {
  assert.ok(SECTIONS.length > 10);
  for (const s of SECTIONS) assert.ok(s.icon, s.id);
  assert.equal(ACCENTS[0].value, 'default');
  assert.ok(SHORTCUT_ACTIONS.some((a) => a.def === null));
});

test('nav highlights the routed section, filters by label or group, and navigates', async () => {
  useStore.setState({ route: { name: 'settings', section: 'appearance' } });
  const { host, unmount } = await render(h(Settings.Nav));
  assert.equal(text(host.querySelector('.side-row.selected')), 'Appearance');
  assert.ok(text(host).includes('Computer Use') || [...host.querySelectorAll('.side-row')].length > 5);
  const input = host.querySelector('.settings-search input')!;
  await setValue(input, 'APPEAR');
  // Back to app is pinned above search, so a search never hides it
  assert.deepEqual([...host.querySelectorAll('.side-row-label')].map(text), ['Back to app', 'Appearance']);
  const group = SECTIONS.find((s) => s.id === 'git')!.group;
  await setValue(input, group.toLowerCase());
  assert.ok([...host.querySelectorAll('.side-row-label')].map(text).includes('Git'));
  await setValue(input, '');
  await click([...host.querySelectorAll('.side-row')].find((b) => text(b) === 'Git')!);
  assert.deepEqual(calls.at(-1), ['navigate', { name: 'settings', section: 'git' }]);
  const back = host.querySelector('.settings-back .side-row')!;
  assert.equal(back.getAttribute('aria-keyshortcuts'), 'Escape');
  assert.equal(back.querySelector('kbd')!.getAttribute('aria-hidden'), 'true', 'its name stays "Back to app"');
  await click(back);
  assert.deepEqual(calls.at(-1), ['leaveSettings']);
  await unmount();
});

test('search: keyword hits name the matched words, marks the query, clears on Escape or the X, and says when nothing matches', async () => {
  useStore.setState({ route: { name: 'settings', section: 'general' } });
  const { host, unmount } = await render(h(Settings.Nav));
  const input = host.querySelector('.settings-search input')!;
  const labels = () => [...host.querySelectorAll('.sidebar-scroll .side-row-label')].map(text);
  assert.equal(host.querySelector('.settings-search-clear') === null, true);
  // found through what the page holds: the words that matched sit under its name, the query marked
  await setValue(input, 'credits');
  assert.equal(labels()[0], 'Accounts & billingCredits · Codex credits');
  const hint = host.querySelector('.side-row.has-hint .side-row-hint')!;
  assert.equal(text(hint.querySelector('mark')), 'Credits');
  // Escape clears the query; another key leaves it
  await key(input, { key: 'a' });
  assert.equal((input as HTMLInputElement).value, 'credits');
  // Escape inside an IME composition ends the composition, not the query
  await key(input, { key: 'Escape', isComposing: true });
  assert.equal((input as HTMLInputElement).value, 'credits');
  await key(input, { key: 'Escape' });
  assert.equal(host.querySelector('.side-row-hint') === null, true);
  assert.ok(host.querySelectorAll('.side-label').length > 1);
  // nothing matches: say so, with words that would
  await setValue(input, '  zzqx ');
  assert.equal(text(host.querySelector('.settings-search-empty')), 'No settings match “zzqx”.Try a word like account, model or browser.');
  await click(host.querySelector('.settings-search-clear')!);
  assert.equal(host.querySelector('.settings-search-empty') === null, true);
  assert.equal(host.querySelector('.settings-search-clear') === null, true);
  await unmount();
});

test('nav leaves out a group with no section to show', async () => {
  const last = SECTIONS.at(-1)!.group;
  const kept = SECTIONS.splice(0, SECTIONS.length);
  SECTIONS.push(...kept.filter((s) => s.group !== last));
  try {
    const { host, unmount } = await render(h(Settings.Nav));
    assert.equal([...host.querySelectorAll('.side-label')].map(text).includes(last), false);
    await unmount();
  } finally {
    SECTIONS.splice(0, SECTIONS.length, ...kept);
  }
});

test('nav outside settings selects General and hides Computer Use when switched off remotely', async () => {
  useStore.setState({ route: { name: 'home' } });
  ctl.flags['shared.computerUse.enabled'] = false;
  const { host, unmount } = await render(h(Settings.Nav));
  assert.equal(text(host.querySelector('.side-row.selected')), 'General');
  assert.ok(
    ![...host.querySelectorAll('.side-row')].some(
      (b) => b.querySelector('.side-row-label') && text(b) === SECTIONS.find((s) => s.id === 'computer')!.label,
    ),
  );
  assert.equal(host.querySelectorAll('.side-row-trailing').length, 0);
  await unmount();
  // a section that opens elsewhere carries a trailing arrow
  SECTIONS.push({ id: 'docs', label: 'Docs', icon: null, group: SECTIONS[0].group, external: true });
  try {
    const r = await render(h(Settings.Nav));
    assert.equal(text([...r.host.querySelectorAll('.side-row')].find((b) => b.querySelector('.side-row-trailing'))), 'Docs');
    await r.unmount();
  } finally {
    SECTIONS.pop();
  }
});

test('each section renders its own panel and an unknown one falls back to the first', async () => {
  const stubs: Record<string, string> = {
    accounts: 'AccountsBilling',
    privacy: 'PrivacySettings',
    harnesses: 'HarnessSettings',
    'other-harnesses': 'OtherHarnesses',
    computer: 'ComputerUseSettings',
    'computer-history': 'ComputerHistorySettings',
  };
  for (const [section, stub] of Object.entries(stubs)) {
    const { host, unmount } = await render(h(Settings, { section }));
    assert.ok(host.querySelector(`[data-stub=${stub}]`), section);
    await unmount();
  }
  let r = await render(h(Settings, { section: 'accounts' }));
  assert.equal(text(r.host.querySelector('h1')), 'Accounts & billing');
  await r.unmount();
  useStore.setState({ route: { name: 'settings', section: 'codex', tab: 'general' } });
  r = await render(h(Settings, { section: 'codex' }));
  const props = JSON.parse(r.host.querySelector('[data-stub=HarnessSection]')!.getAttribute('data-props')!);
  assert.equal(props.section, 'codex');
  await r.unmount();
  r = await render(h(Settings, { section: 'nope' }));
  assert.equal(text(r.host.querySelector('h1')), SECTIONS[0].label);
  await r.unmount();
  useStore.setState({ route: { name: 'home' } });
  r = await render(h(Settings));
  assert.equal(text(r.host.querySelector('h1')), 'General');
  await r.unmount();
});

test('group shows a head only with a title or action, and rows show badges, descriptions and controls', async () => {
  const clicks: string[] = [];
  const { host, unmount } = await render(
    h(
      'div',
      null,
      h(
        Group,
        { title: 'T', desc: 'D' } as any,
        h(Row, { title: 'A', desc: 'about', mono: true, applies: 'codex', onClick: () => clicks.push('A') }, h('b', null, 'ctl')),
      ),
      h(Group, { action: h('button', null, 'act') } as any, h(Row, { title: 'B' })),
      h(Group, null, 'plain'),
    ),
  );
  const groups = host.querySelectorAll('.settings-group');
  assert.equal(text(groups[0].querySelector('.settings-group-title')), 'T');
  assert.equal(text(groups[0].querySelector('.settings-group-desc')), 'D');
  assert.equal(groups[1].querySelector('.settings-group-title'), null);
  assert.ok(groups[1].querySelector('.settings-group-head button'));
  assert.equal(groups[2].querySelector('.settings-group-head'), null);
  const a = row(host, 'A');
  assert.ok(a.className.includes('clickable'));
  assert.ok(a.querySelector('.settings-row-title.mono .applies-to'));
  assert.equal(text(a.querySelector('.settings-row-desc')), 'about');
  await click(a);
  assert.deepEqual(clicks, ['A']);
  // a clickable row is reachable with Tab and pressed with Enter or Space; keys on its control stay the control's
  assert.equal(a.getAttribute('role'), 'button');
  assert.equal(a.tabIndex, 0);
  // named by its title, not by the control inside it
  assert.equal(a.getAttribute('aria-labelledby'), a.querySelector('.settings-row-title')!.id);
  await key(a, { key: 'Enter' });
  await key(a, { key: ' ' });
  await key(a.querySelector('b')!, { key: 'Enter' });
  assert.deepEqual(clicks, ['A', 'A', 'A']);
  const b = row(host, 'B');
  assert.equal(b.getAttribute('role'), null, 'a row without an action is not a control');
  assert.equal(b.hasAttribute('tabindex'), false);
  assert.equal(b.hasAttribute('aria-labelledby'), false);
  assert.equal(b.querySelector('.settings-row-desc'), null);
  assert.equal(b.querySelector('.settings-row-control'), null);
  assert.equal(b.querySelector('.applies-to'), null);
  await unmount();
});

test('the CLI location: found automatically until Change… opens a field that commits on blur or Enter; Reset clears it', async () => {
  const got: any[] = [];
  const onChange = (v: any) => got.push(v);
  const { host, rerender, unmount } = await render(h(BinPathRow, { name: 'codex', value: null, onChange }));
  // nothing set: no empty field, just how it is found and a way to change it
  assert.equal(host.querySelector('input'), null);
  assert.match(text(host), /Found automatically\. Point MoPilot at another codex\./);
  assert.equal(buttons(host, 'Reset').length, 0);
  await click(button(host, 'Change…'));
  let input = host.querySelector('input')!;
  assert.equal(input.getAttribute('placeholder'), '/path/to/codex');
  // Escape with nothing set empties what was typed
  await setValue(input, '/typed');
  await key(input, { key: 'Escape' });
  await click(button(host, 'Change…'));
  input = host.querySelector('input')!;
  assert.equal(input.value, '');
  // leaving it empty changes nothing and closes it
  await blur(input);
  assert.deepEqual(got, []);
  assert.equal(host.querySelector('input'), null);
  await click(button(host, 'Change…'));
  input = host.querySelector('input')!;
  await setValue(input, '  /opt/codex ');
  await key(input, { key: 'a' });
  await key(input, { key: 'Enter' });
  assert.deepEqual(got, ['/opt/codex']);
  await rerender(h(BinPathRow, { name: 'codex', value: '/Users/ada/bin/codex', onChange }));
  // a set path is shown with the home folder shortened, and Reset finds it automatically again
  assert.match(text(host), /~\/bin\/codex/);
  await click(button(host, 'Reset'));
  assert.deepEqual(got, ['/opt/codex', null]);
  // Escape puts the field back as it was and closes it
  await click(button(host, 'Change…'));
  input = host.querySelector('input')!;
  assert.equal(input.value, '/Users/ada/bin/codex');
  await setValue(input, '/elsewhere');
  await key(input, { key: 'Escape' });
  assert.equal(host.querySelector('input'), null);
  assert.deepEqual(got, ['/opt/codex', null]);
  // clearing the field goes back to automatic
  await click(button(host, 'Change…'));
  input = host.querySelector('input')!;
  await setValue(input, '   ');
  await blur(input);
  assert.deepEqual(got, ['/opt/codex', null, null]);
  await unmount();
});

const MODES = [
  { value: 'q', label: 'Q' },
  { value: 'r', label: 'R' },
];

test('a toggle whose change is a promise shows the value being written and takes no second click until it settles', async () => {
  const writes: boolean[] = [];
  const runs: { resolve: () => void }[] = [];
  const onChange = (v: boolean) => {
    writes.push(v);
    return new Promise<void>((resolve) => runs.push({ resolve }));
  };
  const { host, unmount } = await render(h(Toggle, { on: true, onChange }));
  const sw = host.querySelector('[role=switch]') as HTMLButtonElement;
  const state = () => [
    sw.getAttribute('aria-checked'),
    sw.getAttribute('aria-disabled') === 'true',
    sw.getAttribute('aria-busy'),
    sw.classList.contains('on'),
  ];
  assert.deepEqual(state(), ['true', false, null, true]);
  // off: shown at once and held, so a quick second click cannot write `false` again from the stale `on`; the
  // switch stays focusable (aria-disabled, not disabled), so a keyboard user does not lose their place
  sw.focus();
  await click(sw);
  assert.equal(sw.disabled, false);
  assert.equal(document.activeElement, sw);
  assert.deepEqual(state(), ['false', true, 'true', false]);
  await click(sw);
  assert.deepEqual(writes, [false]);
  // settled: `on` (here unchanged by the caller) is shown again and the switch takes clicks
  runs[0].resolve();
  await flush();
  assert.deepEqual(state(), ['true', false, null, true]);
  // a write that failed (the handler said so and did not re-read) ends the pending state on the unchanged `on` too
  await click(sw);
  runs[1].resolve();
  await flush();
  assert.deepEqual(state(), ['true', false, null, true]);
  assert.deepEqual(writes, [false, false]);
  await unmount();
});

test('a toggle whose change is a promise flips what it shows once the caller re-read: the next click writes the other value', async () => {
  const writes: boolean[] = [];
  function Parent() {
    const [on, setOn] = React.useState(true);
    return h(Toggle, {
      on,
      onChange: async (v: boolean) => {
        writes.push(v);
        await Promise.resolve();
        setOn(v);
      },
    });
  }
  const { host, unmount } = await render(h(Parent));
  const sw = host.querySelector('[role=switch]') as HTMLButtonElement;
  await click(sw);
  await flush();
  await click(sw);
  await flush();
  assert.deepEqual(writes, [false, true]);
  assert.equal(sw.getAttribute('aria-checked'), 'true');
  await unmount();
});

test('a toggle treats any thenable its change returns as pending, and a plain value as done at once', async () => {
  let finish: () => void = () => {};
  const thenable = { then: (ok: () => void) => void (finish = ok) };
  const plain: boolean[] = [];
  const { host, unmount } = await render(
    h('div', null, h(Toggle, { on: false, onChange: () => thenable }), h(Toggle, { on: false, onChange: (v: boolean) => plain.push(v) })),
  );
  const [pending, sync] = host.querySelectorAll('[role=switch]');
  await click(pending);
  assert.equal(pending.getAttribute('aria-busy'), 'true');
  finish();
  await flush();
  assert.equal(pending.getAttribute('aria-busy'), null);
  await click(sync);
  await click(sync);
  assert.deepEqual(plain, [true, true]);
  assert.equal(sync.getAttribute('aria-busy'), null);
  await unmount();
});

test('toggle, select and segmented controls report the chosen value', async () => {
  const got: any[] = [];
  const { host, unmount } = await render(
    h(
      'div',
      null,
      h(Toggle, { on: true, onChange: (v: boolean) => got.push(['t', v]) }),
      h(Toggle, { on: false, disabled: true, onChange: () => {} }),
      h(
        'div',
        { id: 'sel' },
        h(Select, {
          value: 'b',
          options: [
            { value: 'a', label: 'Alpha' },
            { value: 'b', label: 'Beta' },
          ],
          onChange: (v: string) => got.push(['s', v]),
        }),
      ),
      h('div', { id: 'sel2' }, h(Select, { value: 'zz', width: 300, options: [{ value: 'a', label: 'Alpha' }], onChange: () => {} })),
      h(Segmented, {
        value: 'x',
        options: [
          { value: 'x', label: 'X' },
          { value: 'y', label: 'Y' },
        ],
        onChange: (v: string) => got.push(['g', v]),
      }),
      // a control standing on its own names itself and carries the caller's own class
      h('div', { id: 'named' }, h(Segmented, { value: 'q', label: 'Diff mode', className: 'cp-mode', options: MODES, onChange: () => {} })),
    ),
  );
  const [on, off] = host.querySelectorAll('[role=switch]');
  assert.equal(on.getAttribute('aria-checked'), 'true');
  assert.ok((off as HTMLButtonElement).disabled);
  await click(on);
  const sel = host.querySelector('#sel')!;
  assert.equal(text(sel.querySelector('.select-btn')), 'Beta');
  await pick(sel, 'Alpha');
  assert.deepEqual(
    [...sel.querySelectorAll('.menu-item')].map((b) => b.getAttribute('aria-checked')),
    ['false', 'true'],
  );
  assert.equal(text(host.querySelector('#sel2 .select-btn')), 'zz');
  assert.equal(text(host.querySelector('.segmented .on')), 'X');
  // which segment is on is said, not only coloured, and a row that names the control itself adds no label
  assert.deepEqual(
    [...host.querySelectorAll('.segmented')].map((g) => [g.className, g.getAttribute('role'), g.getAttribute('aria-label')]),
    [
      ['segmented', 'group', null],
      ['segmented cp-mode', 'group', 'Diff mode'],
    ],
  );
  assert.deepEqual(
    [...host.querySelectorAll('#named button')].map((b) => [b.textContent, b.getAttribute('aria-pressed')]),
    [
      ['Q', 'true'],
      ['R', 'false'],
    ],
  );
  await click(button(host, 'Y'));
  assert.deepEqual(got, [
    ['t', false],
    ['s', 'a'],
    ['g', 'y'],
  ]);
  await unmount();
});

test('inline code renders backtick spans as code and groupBy buckets by key', async () => {
  const { host, unmount } = await render(h(InlineCode, { text: 'run `npm i` then `go`.' }));
  assert.deepEqual([...host.querySelectorAll('code')].map(text), ['npm i', 'go']);
  assert.equal(text(host), 'run npm i then go.');
  await unmount();
  assert.deepEqual(
    groupBy([1, 2, 3, 4], (n) => (n % 2 ? 'odd' : 'even')),
    { odd: [1, 3], even: [2, 4] },
  );
});

test('effort select toggles stops in canonical order and never empties the list', async () => {
  const { host, unmount } = await render(h(EffortsSelect));
  assert.equal(text(host.querySelector('.select-btn')), '5 selected');
  await click(host.querySelector('.select-btn')!);
  assert.equal(options(host).length, 7);
  await click([...host.querySelectorAll('.menu-item')][0]);
  assert.deepEqual(lastPrefs(), { visibleEfforts: ['none', 'low', 'medium', 'high', 'xhigh', 'max'] });
  useStore.setState({ prefs: { ...useStore.getState().prefs, visibleEfforts: ['high'] } });
  await flush();
  const before = calls.length;
  await click([...host.querySelectorAll('.menu-item')][4]);
  assert.equal(calls.length, before);
  await click([...host.querySelectorAll('.menu-item')][3]);
  assert.deepEqual(lastPrefs(), { visibleEfforts: ['medium', 'high'] });
  await unmount();
});
