// A harness's one "Version" row (components/harness/HarnessVersionRow.tsx), the same for every harness family: the
// version and how it was installed in words, the path only on hover, an update's state, and the menu that picks
// another install, shows it in Finder, chooses another path or resets.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  setup,
  calls,
  resetCtl,
  defaultState,
  useStore,
  render,
  click,
  text,
  button,
  row,
  options,
  setValue,
  blur,
  key,
} from './support/settings-harness.ts';

await setup();
const { createElement: h, act } = await import('react');
const { HarnessVersionRow } = await import('../src/components/harness/HarnessVersionRow.tsx');
const { useHarnessUpdates } = await import('../src/harness/harnessUpdates.ts');
const { INSTALL_SOURCE_CASES } = await import('./support/install-source-cases.ts');

const picked: (string | null)[] = [];
const base = { kind: 'claude', label: 'Claude Code', name: 'claude', manual: null, onPick: (p: string | null) => picked.push(p) };
const info = (over: any) => ({
  harness: 'claude',
  bin: '/a/claude',
  installed: '2.1.302',
  latest: '2.1.302',
  via: 'self',
  from: 'standalone install',
  command: 'claude update',
  updatable: false,
  blockedReason: null,
  latestStatus: 'ok',
  checkedAt: 1,
  state: 'idle',
  waitingFor: 0,
  runId: null,
  outcome: null,
  ...over,
});
const desc = (host: Element) => text(row(host, 'Version').querySelector('.settings-row-desc'));
const menu = (host: Element) => click(button(row(host, 'Version'), 'Claude Code CLI options'));
/** Picks the menu item `label`, opening the row's menu first unless it is open. */
async function pick(v: Element, label: string) {
  if (!v.querySelector('.menu')) await click(button(v, 'Claude Code CLI options'));
  const item = [...v.querySelectorAll('.menu .menu-item')].find((b) => text(b) === label);
  if (!item) throw new Error(`no item "${label}" in: ${text(v.querySelector('.menu'))}`);
  await click(item);
}
/** main's update check changes: the row follows it on its own. */
const checks = (harnesses: any[]) => act(async () => useHarnessUpdates.setState({ harnesses }));

beforeEach(() => {
  resetCtl();
  useStore.setState(defaultState(), true);
  useHarnessUpdates.setState({ harnesses: [] });
  picked.length = 0;
});

test('none found: "Not found" (or what is under way), and another path can still be chosen', async () => {
  const r = await render(h(HarnessVersionRow, { ...base, bin: null, version: null }));
  assert.equal(desc(r.host), 'Not found');
  await menu(r.host);
  assert.deepEqual(options(r.host), ['Choose another…']);
  await r.unmount();
  const p = await render(h(HarnessVersionRow, { ...base, bin: null, version: null, pending: 'Detecting…' }));
  assert.equal(desc(p.host), 'Detecting…');
  await p.unmount();
});

test('several installs: a menu headed by how many, each with its path on hover, the one in use checked', async () => {
  const installs = [
    { path: '/a/claude', version: '2.1.302', via: 'self', from: 'standalone install' },
    { path: '/b/claude', version: '2.1.296', via: 'npm', from: 'npm (/usr/local)' },
    { path: '/c/claude', version: '2.0.0', via: 'app-bundle', from: 'Claude.app' },
  ];
  const r = await render(h(HarnessVersionRow, { ...base, bin: '/a/claude', version: '2.1.302', installs }));
  assert.equal(desc(r.host), '2.1.302 · Native installer');
  assert.equal(row(r.host, 'Version').querySelector('.cli-line')!.getAttribute('title'), '/a/claude');
  await menu(r.host);
  const v = row(r.host, 'Version');
  assert.equal(text(v.querySelector('.menu header')), '3 installs found');
  assert.deepEqual(options(v), [
    '2.1.302 · Native installer',
    '2.1.296 · npm',
    '2.0.0 · Bundled with Claude.app',
    'Show in Finder',
    'Choose another…',
  ]);
  assert.deepEqual(
    [...v.querySelectorAll('.menu-item')].map((b) => [b.getAttribute('title'), b.getAttribute('aria-checked')]),
    [
      ['/a/claude', 'true'],
      ['/b/claude', 'false'],
      ['/c/claude', 'false'],
      ['/a/claude', null],
      [null, null],
    ],
  );
  // the one in use again changes nothing; another is the harness's own pick
  await pick(v, '2.1.302 · Native installer');
  await pick(v, '2.1.296 · npm');
  assert.deepEqual(picked, ['/b/claude']);
  await r.unmount();
});

test("main's update check of this binary names how it was installed; its update line goes under the row", async () => {
  await checks([info({ latest: '2.2.0', updatable: true })]);
  const footer = h('i', { 'data-footer': true }, 'Update to 2.2.0');
  const r = await render(h(HarnessVersionRow, { ...base, bin: '/a/claude', version: '2.1.302', footer }));
  // no install list from main: the update check's own read of this binary names it; the update is the page's
  // version line, not a second pill here
  assert.equal(text(row(r.host, 'Version').querySelector('.cli-line')), '2.1.302 · Native installer');
  assert.equal(row(r.host, 'Version').querySelector('.hver-pill'), null);
  assert.equal(text(row(r.host, 'Version').querySelector('[data-footer]')), 'Update to 2.2.0');
  // a check of another binary (or of another harness) says nothing about this one
  await checks([info({ bin: '/b/claude', via: 'brew' }), info({ harness: 'codex', bin: '/a/claude', via: 'npm' })]);
  assert.equal(text(row(r.host, 'Version').querySelector('.cli-line')), '2.1.302');
  await r.unmount();
});

test('the row names the install as the page header does, for every case of the shared matrix', async () => {
  for (const c of INSTALL_SOURCE_CASES) {
    await checks([info({ bin: c.bin, ...c.check })]);
    const r = await render(h(HarnessVersionRow, { ...base, bin: c.bin, version: '2.1.302', installs: c.installs, manual: c.manual }));
    assert.equal(desc(r.host), `2.1.302 · ${c.words}`, c.name);
    await r.unmount();
  }
});

test('a custom location reads so, shows in Finder, and resets; Choose another… saves on Enter, keeps on Escape', async () => {
  const r = await render(
    h(HarnessVersionRow, {
      ...base,
      bin: '/w/claude',
      version: '2.1.302',
      manual: '/w/claude',
      installs: [{ path: '/a/claude', version: '2.1.302', via: 'self', from: '' }],
      where: { offPath: true, terminal: '/a/claude' },
    }),
  );
  const v = row(r.host, 'Version');
  assert.equal(text(v.querySelector('.cli-line')), '2.1.302 · Custom location');
  assert.equal(text(v.querySelector('.cli-offpath')), 'Your terminal runs a different Claude Code');
  await menu(r.host);
  assert.deepEqual(options(v), ['Show in Finder', 'Choose another…', 'Reset']);
  const reset = [...v.querySelectorAll('.menu-item')].find((b) => text(b) === 'Reset')!;
  assert.equal(reset.getAttribute('title'), 'Stop using /w/claude and find Claude Code automatically');
  await pick(v, 'Show in Finder');
  assert.deepEqual(calls.at(-1), ['shell.reveal', '/w/claude']);
  await pick(v, 'Reset');
  assert.deepEqual(picked, [null]);
  // the field opens with the path set; Escape puts it back and closes it, nothing picked
  await pick(v, 'Choose another…');
  const input = () => v.querySelector('input') as HTMLInputElement;
  assert.equal(input().value, '/w/claude');
  assert.equal(input().getAttribute('aria-label'), 'claude binary path');
  assert.equal(v.querySelector('[aria-label="Claude Code CLI options"]'), null, 'the field stands in for the menu');
  await setValue(input(), '/other');
  await key(input(), { key: 'Escape' });
  assert.equal(input(), null);
  assert.deepEqual(picked, [null]);
  // the same path again: nothing to save
  await pick(v, 'Choose another…');
  await blur(input());
  assert.deepEqual(picked, [null]);
  // a new one saves on Enter; an emptied field finds it automatically again
  await pick(v, 'Choose another…');
  await setValue(input(), '  /new/claude ');
  await key(input(), { key: 'Enter' });
  await pick(v, 'Choose another…');
  await setValue(input(), '   ');
  await blur(input());
  assert.deepEqual(picked, [null, '/new/claude', null]);
  await r.unmount();
});
