// Settings › MoMo (src/components/momo/settings/MomoSettings.tsx, Proactivity.tsx, SourcesSlot.tsx and its entry in Settings.tsx): no trace of it for an account MoMo isn't allowed for (sidebar, search, a deep link), then its Brain, Routines and Sources tabs and the Proactivity settings saved through main, and gone again when MoMo is revoked.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  setup,
  calls,
  responses,
  useStore,
  defaultState,
  render,
  click,
  text,
  button,
  row,
  setValue,
  flush,
  act,
  blur,
  key,
} from './support/settings-harness.ts';
await setup();
const { createElement: h } = await import('react');
let push: (allowed: boolean) => void = () => {};
responses['momo.access'] = () => Promise.resolve(false);
responses['momo.onAccess'] = (cb: (a: boolean) => void) => ((push = cb), () => {});
responses['momoPrefs.set'] = () => Promise.resolve(true);
// the brain has its own test (tests/momoBrainSettingsUI.test.ts), name and style theirs (tests/momoNameStyleUI.test.ts)
(globalThis as any).__settingsMocks[new URL('../src/components/momo/settings/Brain.tsx', import.meta.url).href] = {
  BrainSettings: () => h('div', { 'data-stub': 'BrainSettings' }),
};
(globalThis as any).__settingsMocks[new URL('../src/components/momo/settings/NameStyle.tsx', import.meta.url).href] = {
  NameStyleSettings: () => h('div', { 'data-stub': 'NameStyleSettings' }),
};
// the routines tab has its own test (tests/momoRoutinesSettingsUI.test.ts)
(globalThis as any).__settingsMocks[new URL('../src/components/momo/settings/RoutinesSettings.tsx', import.meta.url).href] = {
  RoutinesSettings: () => h('div', { 'data-stub': 'RoutinesSettings' }),
};
// the sources section too (tests/momoSourcesSectionUI.test.ts)
(globalThis as any).__settingsMocks[new URL('../src/components/momo/SourcesSection.tsx', import.meta.url).href] = {
  SourcesSection: () => h('div', { 'data-stub': 'SourcesSection' }),
};
const { Settings } = await import('../src/components/pages/Settings.tsx');
const { SECTIONS } = await import('../src/components/pages/Settings.tsx');

const settle = async () => {
  for (let i = 0; i < 6; i++) await flush();
};
const navRows = (host: Element) =>
  [...host.querySelectorAll('.settings-nav .side-row')].map((r) => text(r.querySelector('.side-row-label')));
const saved = () => calls.filter((c) => c[0] === 'momoPrefs.set').map((c) => c.slice(1));
/** what main's broadcast of a saved change does to this window's prefs */
const savedMomo = (momo: unknown) => act(() => useStore.setState({ prefs: { ...useStore.getState().prefs, momo } }));

test('not allowed: no MoMo in the sidebar, its search, the search palette’s sections or a link to it', async () => {
  useStore.setState({ ...defaultState(), route: { name: 'settings', section: 'momo' } }, true);
  const nav = await render(h(Settings.Nav));
  const page = await render(h(Settings, { section: 'momo' }));
  await settle();
  assert.ok(navRows(nav.host).includes('Privacy'));
  assert.ok(!navRows(nav.host).includes('MoMo'));
  await setValue(nav.host.querySelector('input')!, 'momo');
  assert.match(text(nav.host), /No settings match “momo”/);
  // nor do MoMo's own words find anything (a word only MoMo's page lists: General has its own "Notification quiet hours")
  await setValue(nav.host.querySelector('input')!, 'proactivity');
  assert.match(text(nav.host), /No settings match/);
  assert.ok(!SECTIONS.some((s) => s.id === 'momo'), 'the search palette lists SECTIONS');
  // an unknown section's page (the stand-in for the harness pages is all that names it)
  assert.equal(text(page.host.querySelector('.settings-title')), 'Accounts & billing');
  assert.doesNotMatch(text(page.host), /MoMo/i);
  assert.equal(page.host.querySelector('.settings-tabs'), null);
  // main answers no: still nothing
  await act(async () => push(false));
  assert.doesNotMatch(text(page.host), /MoMo/i);
  // the page module itself renders nothing for such an account
  const { default: MomoSettings } = await import('../src/components/momo/settings/MomoSettings.tsx');
  const direct = await render(h(MomoSettings, { tab: 'sources' }));
  assert.equal(direct.host.innerHTML, '');
  await direct.unmount();
  await nav.unmount();
  await page.unmount();
});

test('allowed: listed under App, its Brain, Routines and Sources tabs, and gone again once revoked', async () => {
  useStore.setState({ ...defaultState(), route: { name: 'settings', section: 'general' } }, true);
  calls.length = 0;
  await act(async () => push(true));
  const nav = await render(h(Settings.Nav));
  await settle();
  const rows = navRows(nav.host);
  assert.equal(rows[rows.indexOf('Privacy') + 1], 'MoMo', 'the last App row');
  const momoRow = [...nav.host.querySelectorAll('.side-row')].find((r) => text(r) === 'MoMo') as HTMLElement;
  assert.ok(momoRow.querySelector('.momo-dot'));
  await click(momoRow);
  assert.deepEqual(calls.at(-1), ['navigate', { name: 'settings', section: 'momo' }]);
  await setValue(nav.host.querySelector('input')!, 'mom');
  assert.deepEqual(navRows(nav.host), ['Back to app', 'MoMo']);
  // its own words find it while it is listed
  await setValue(nav.host.querySelector('input')!, 'proactivity');
  assert.deepEqual(navRows(nav.host), ['Back to app', 'MoMoProactivity']);
  await setValue(nav.host.querySelector('input')!, '');

  await act(() => useStore.setState({ route: { name: 'settings', section: 'momo' } }));
  assert.ok(nav.host.querySelector('.side-row.selected')?.textContent?.includes('MoMo'));
  const page = await render(h(Settings, { section: 'momo' }));
  await settle();
  assert.equal(text(page.host.querySelector('.settings-title')), 'MoMo');
  const tabs = [...page.host.querySelectorAll('.settings-tabs button')];
  assert.deepEqual(
    tabs.map((b) => [text(b), b.getAttribute('aria-pressed')]),
    [
      ['Brain', 'true'],
      ['Routines', 'false'],
      ['Sources', 'false'],
    ],
  );
  assert.ok(row(page.host, 'How often MoMo reaches out'));
  assert.ok(page.host.querySelector('[data-stub=BrainSettings]'), 'the one brain first, no roles');
  assert.ok(page.host.querySelector('[data-stub=NameStyleSettings]'), 'name and style, moved out of setup');
  await click(tabs[1]);
  assert.deepEqual(calls.at(-1), ['navigate', { name: 'settings', section: 'momo', tab: 'routines' }]);
  await act(() => useStore.setState({ route: { name: 'settings', section: 'momo', tab: 'routines' } }));
  await settle();
  assert.ok(page.host.querySelector('[data-stub=RoutinesSettings]'), 'MoMo’s routines');
  assert.equal(page.host.querySelector('[data-stub=BrainSettings]'), null);
  await click(tabs[2]);
  assert.deepEqual(calls.at(-1), ['navigate', { name: 'settings', section: 'momo', tab: 'sources' }]);
  await act(() => useStore.setState({ route: { name: 'settings', section: 'momo', tab: 'sources' } }));
  await settle();
  assert.ok(page.host.querySelector('[data-stub=SourcesSection]'), 'MoMo’s sources section');

  await act(async () => push(false));
  await settle();
  assert.ok(!navRows(nav.host).includes('MoMo'));
  assert.equal(text(page.host.querySelector('.settings-title')), 'Accounts & billing');
  assert.doesNotMatch(text(page.host), /MoMo|Sources/);
  await nav.unmount();
  await page.unmount();
});

test('Proactivity: each change is saved through main, and the page shows what main saved', async () => {
  useStore.setState({ ...defaultState(), route: { name: 'settings', section: 'momo' } }, true);
  calls.length = 0;
  await act(async () => push(true));
  const page = await render(h(Settings, { section: 'momo' }));
  await settle();
  const reach = row(page.host, 'How often MoMo reaches out');
  assert.match(text(reach), /^How often MoMo reaches outUp to 6 routine runs a day\./);
  await click(button(reach, 'High'));
  assert.deepEqual(saved().at(-1), ['routines.proactivity', 'high']);
  await savedMomo({ routines: { proactivity: 'off' } });
  assert.match(text(reach), /No routines\./);
  assert.equal(button(reach, 'Off').getAttribute('aria-pressed'), 'true');

  const quiet = row(page.host, 'Quiet hours');
  const start = quiet.querySelector<HTMLInputElement>('[aria-label="Quiet hours start"]')!;
  const end = quiet.querySelector<HTMLInputElement>('[aria-label="Quiet hours end"]')!;
  assert.deepEqual([start.value, end.value], ['22:00', '07:00']);
  // typing passes through other times: nothing is saved until the field is left
  await setValue(start, '01:15');
  await setValue(start, '23:15');
  assert.equal(saved().length, 1);
  await blur(start);
  assert.deepEqual(saved().at(-1), ['routines.quietHours', { start: '23:15', end: '07:00' }]);
  await savedMomo({ routines: { quietHours: { start: '23:15', end: '07:00' } } });
  const n = saved().length;
  // the end at the start: refused and told, and the field goes back to what is saved
  await setValue(end, '23:15');
  await blur(end);
  assert.equal(saved().length, n);
  assert.deepEqual(calls.filter((c) => c[0] === 'toast').at(-1), ['toast', "Quiet hours can't start and end at the same time", 'error']);
  assert.equal(end.value, '07:00');
  // a cleared field, or the time already saved: nothing to save
  await setValue(end, '');
  await blur(end);
  assert.equal(end.value, '07:00');
  await blur(start);
  assert.equal(saved().length, n);
  // Enter saves too; main refusing it puts the saved time back
  responses['momoPrefs.set'] = () => Promise.reject(Object.assign(new Error("Couldn't save MoMo's settings."), { code: 'save_failed' }));
  end.focus();
  await setValue(end, '06:30');
  await key(end, { key: 'Enter' });
  await flush();
  assert.deepEqual(saved().at(-1), ['routines.quietHours', { start: '23:15', end: '06:30' }]);
  assert.equal(end.value, '07:00');
  await key(end, { key: 'Tab' });
  responses['momoPrefs.set'] = () => Promise.resolve(true);
  await click(quiet.querySelector('.toggle')!);
  await flush();
  assert.deepEqual(saved().at(-1), ['routines.quietHours', null]);
  await savedMomo({ routines: { quietHours: null } });
  assert.equal(quiet.querySelector('input'), null, 'off: no times');
  assert.match(text(quiet), /Off/);
  await click(quiet.querySelector('.toggle')!);
  await flush();
  assert.deepEqual(saved().at(-1), ['routines.quietHours', { start: '22:00', end: '07:00' }], 'on again at the usual times');
  await savedMomo({ routines: { quietHours: { start: '21:00', end: '06:00' } } });
  assert.equal(quiet.querySelector<HTMLInputElement>('[aria-label="Quiet hours start"]')!.value, '21:00', 'a change saved elsewhere shows');

  assert.equal(
    [...page.host.querySelectorAll('.settings-row')].some((r) => /^Feed|topic/.test(text(r))),
    false,
    'no Feed time and no topic toggle',
  );
  await click(row(page.host, 'Notify when MoMo needs an answer').querySelector('.toggle')!);
  await flush();
  assert.deepEqual(saved().at(-1), ['notify.needsAnswer', false]);
  // the push body opt-in (A6): off by default, saved through main, shown on once saved
  const named = row(page.host, 'Name my routine in phone alerts');
  assert.match(text(named), /Only the name of a routine you approved/);
  assert.equal(named.querySelector('.toggle')!.getAttribute('aria-checked'), 'false');
  await click(named.querySelector('.toggle')!);
  await flush();
  assert.deepEqual(saved().at(-1), ['notify.pushBody', true]);
  await savedMomo({ notify: { pushBody: true } });
  assert.equal(row(page.host, 'Name my routine in phone alerts').querySelector('.toggle')!.getAttribute('aria-checked'), 'true');
  // the morning brief (A7): off by default, saved through main, shown on once saved, and off again from here
  const brief = row(page.host, 'Morning brief');
  assert.match(text(brief), /A short note in MoMo’s chat when quiet hours end/);
  assert.equal(brief.querySelector('.toggle')!.getAttribute('aria-checked'), 'false');
  await click(brief.querySelector('.toggle')!);
  await flush();
  assert.deepEqual(saved().at(-1), ['brief', true]);
  await savedMomo({ brief: true });
  assert.equal(row(page.host, 'Morning brief').querySelector('.toggle')!.getAttribute('aria-checked'), 'true');
  await click(row(page.host, 'Morning brief').querySelector('.toggle')!);
  await flush();
  assert.deepEqual(saved().at(-1), ['brief', false]);
  await page.unmount();
});
