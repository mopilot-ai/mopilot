// Settings › Superagent (src/components/superagent): every state of the page, every control, and its place in the Settings nav behind the `superagent` flag.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  setup,
  calls,
  ctl,
  resetCtl,
  responses,
  defaultState,
  useStore,
  render,
  click,
  text,
  button,
  buttons,
  row,
  flush,
  setValue,
  key,
} from './support/settings-harness.ts';

await setup();
const { createElement: h } = await import('react');
const { default: SuperagentSettings } = await import('../src/components/superagent/SuperagentSettings.tsx');
const { Settings } = await import('../src/components/pages/Settings.tsx');
const M = await import('../src/components/superagent/model.ts');

const rule = (id: string, name: string, mode = 'observe', available = true) => ({ id, name, line: `${name} line.`, mode, available });
const okState = (o: any = {}) => ({
  ok: true,
  config: {
    repo: 'acme/widgets',
    allowed: ['alice', 'bob'],
    botLogin: 'mopilot-superagent',
    paused: { all: false, github: false },
    rules: [rule('explicit', 'Explicit requests'), rule('ci', 'Fix red checks', 'observe', false), rule('bugs', 'Reproduce bugs', 'off')],
  },
  log: [
    {
      id: 'd1',
      at: 1,
      outcome: 'would_accept',
      verdict: 'Would accept',
      what: 'Issue #7 from alice: it crashes',
      reasonText: 'Observe mode: would accept (Reproduce bugs)',
      rule: 'bugs',
      mark: null,
      url: null,
    },
    {
      id: 'd2',
      at: 2,
      outcome: 'would_ignore',
      verdict: 'Would ignore',
      what: 'Issue #8 from mallory',
      reasonText: "The sender is not on the Source's list",
      rule: null,
      mark: 'wrong',
      url: null,
    },
  ],
  stats: { total: 2, wouldAccept: 1, marked: 0, right: 0, wrong: 0, precision: null },
  reconcile: [],
  source: { state: 'watching', repo: 'acme/widgets' },
  ...o,
});
const stopped = (error: any) => ({ ok: false, error, source: { state: 'stopped', reason: 'off' } });
const toasts = () => calls.filter((c) => c[0] === 'toast').map((c) => [c[1], c[2]]);
const called = (name: string) => calls.filter((c) => c[0] === name).map((c) => c.slice(1));
const open = async (state: any) => {
  responses['superagent.state'] = () => Promise.resolve(typeof state === 'function' ? state() : state);
  const r = await render(h(SuperagentSettings));
  await flush();
  return r;
};

beforeEach(() => {
  resetCtl();
  useStore.setState(defaultState(), true);
});

test('model lines: what the watcher is doing, the precision, each problem, the plurals and the typed logins', () => {
  assert.equal(M.sourceText({ state: 'watching', repo: 'a/b' }), 'Watching a/b');
  assert.equal(M.sourceText({ state: 'watching', repo: 'a/b', health: { state: 'ok' } }), 'Watching a/b');
  assert.equal(M.sourceText({ state: 'watching', repo: 'a/b', health: { state: 'unchanged' } }), 'Watching a/b');
  assert.equal(
    M.sourceText({ state: 'watching', repo: 'a/b', health: { state: 'error', reason: 'No GitHub token' } }),
    "Can't read a/b: No GitHub token. Trying again.",
  );
  assert.equal(
    M.sourceText({ state: 'watching', repo: 'a/b', health: { state: 'error' } }),
    "Can't read a/b: GitHub did not answer. Trying again.",
  );
  assert.equal(
    M.sourceText({ state: 'watching', repo: 'a/b', health: { state: 'limited' } }),
    'Watching a/b. GitHub is limiting requests; waiting.',
  );
  const why = (reason: any) => M.sourceText({ state: 'stopped', reason });
  assert.deepEqual(['no_repo', 'paused', 'no_source', 'off', 'idle', 'error'].map(why), [
    'Pick a repository to start.',
    'Paused.',
    'This build has no GitHub source yet.',
    'Off.',
    'Starting…',
    'The GitHub source could not start. Change the repository to try again.',
  ]);
  const stats = (precision: number | null) => ({ total: 3, wouldAccept: 3, marked: 3, right: 2, wrong: 1, precision });
  assert.equal(M.precisionText(stats(null)), 'Mark entries Right or Wrong to measure it.');
  assert.equal(M.precisionText(stats(2 / 3)), '67% right (2 of 3 marked)');
  assert.equal(
    M.problemText({ code: 'damaged', message: 'x', setAside: '/p/db.damaged-1' }),
    "Superagent can't read its database. The damaged copy is kept at /p/db.damaged-1.",
  );
  assert.equal(
    M.problemText({ code: 'damaged', message: 'x', setAside: null }),
    "Superagent can't read its database. The damaged copy was left in place.",
  );
  assert.match(M.problemText({ code: 'newer', message: 'x', setAside: null }), /newer MoPilot/);
  assert.equal(M.problemText({ code: 'off', message: 'x', setAside: null }), 'Superagent is off.');
  assert.equal(M.problemText({ code: 'failed', message: 'database is locked.', setAside: null }), 'database is locked. Trying again.');
  assert.deepEqual(M.loginsFrom('alice, @bob  carol\n,dave,'), ['alice', '@bob', 'carol', 'dave']);
  assert.deepEqual(M.loginsFrom(''), []);
});

test('nothing shows until the state arrives; a failing read says so', async () => {
  responses['superagent.state'] = () => new Promise(() => {});
  const waiting = await render(h(SuperagentSettings));
  await flush();
  assert.equal(text(waiting.host), '');
  await waiting.unmount();
  responses['superagent.state'] = () => Promise.reject(new Error('main is busy'));
  const failed = await render(h(SuperagentSettings));
  await flush();
  assert.match(text(failed.host), /Superagent.*main is busy/);
});

test('a damaged database: one line, where the copy is kept, and a fresh start only after a confirm', async () => {
  const { host } = await open(stopped({ code: 'damaged', message: 'bad', setAside: '/data/superagent.db.damaged-5' }));
  assert.match(
    text(host),
    /Superagent stopped.*Superagent can't read its database\. The damaged copy is kept at \/data\/superagent\.db\.damaged-5\./,
  );
  assert.equal(buttons(host, 'Start fresh').length, 0, 'the confirm is not shown yet');
  await click(button(host, 'Start fresh…'));
  assert.match(text(host), /Start a fresh database\?/);
  assert.equal(called('superagent.acknowledge').length, 0, 'nothing started by the first click');
  await click(button(host, 'Cancel'));
  assert.equal(buttons(host, 'Start fresh…').length, 1, 'cancelled: back to the one button');
  assert.equal(called('superagent.acknowledge').length, 0);
  await click(button(host, 'Start fresh…'));
  responses['superagent.acknowledge'] = () => Promise.resolve(true);
  responses['superagent.state'] = () => Promise.resolve(okState());
  await click(button(host, 'Start fresh'));
  await flush();
  assert.equal(called('superagent.acknowledge').length, 1);
  assert.match(text(host), /1\. Connect/);
});

test('a refused fresh start is told and closes the confirm', async () => {
  const { host } = await open(stopped({ code: 'damaged', message: 'bad', setAside: null }));
  assert.match(text(host), /left in place/);
  await click(button(host, 'Start fresh…'));
  responses['superagent.acknowledge'] = () => Promise.reject(new Error('There is no damaged database to replace.'));
  await click(button(host, 'Start fresh'));
  await flush();
  assert.deepEqual(toasts(), [['There is no damaged database to replace.', 'error']]);
  assert.equal(buttons(host, 'Start fresh').length, 0);
});

test('a newer database, a failing open and off show their line and offer no way to replace anything', async () => {
  for (const [error, line] of [
    [{ code: 'newer', message: 'n', setAside: null }, /newer MoPilot/],
    [{ code: 'failed', message: 'database is locked', setAside: null }, /database is locked\. Trying again\./],
    [{ code: 'off', message: 'o', setAside: null }, /Superagent is off\./],
  ] as const) {
    const { host, unmount } = await open(stopped(error));
    assert.match(text(host), line);
    assert.equal(host.querySelectorAll('button').length, 0);
    await unmount();
  }
});

test('the page: its four groups, the repository and people as saved, rules with Auto waiting, the log', async () => {
  const { host } = await open(okState());
  for (const title of ['1. Connect', '2. Choose what it may start', '3. Read what it would have done'])
    assert.match(text(host), new RegExp(title.replace('.', '\\.')));
  assert.equal((host.querySelector('input[aria-label="Repository"]') as HTMLInputElement).value, 'acme/widgets');
  assert.equal((host.querySelector('input[aria-label="Allowed people"]') as HTMLInputElement).value, 'alice, bob');
  assert.match(text(row(host, 'Repository')), /Watching acme\/widgets/);
  assert.match(text(host), /A mention of @mopilot-superagent is an explicit request\./);
  const explicit = row(host, 'Explicit requests');
  assert.equal(explicit.querySelector('button.on')?.textContent, 'Observe');
  assert.equal((button(explicit, 'Auto') as HTMLButtonElement).disabled, true, 'Auto waits for the next phase');
  assert.equal(row(host, 'Reproduce bugs').querySelector('button.on')?.textContent, 'Off');
  assert.match(text(row(host, 'Fix red checks')), /Not watched yet\./);
  assert.equal(row(host, 'Fix red checks').querySelector('button.on'), null, 'a rule that is not watched shows no mode');
  assert.equal(
    [...row(host, 'Fix red checks').querySelectorAll('button')].every((b) => (b as HTMLButtonElement).disabled),
    true,
  );
  assert.match(text(row(host, 'Precision')), /Mark entries Right or Wrong/);
  assert.match(text(host), /Would accept.*Issue #7 from alice: it crashes\. Observe mode: would accept/);
  assert.equal(row(host, 'Would ignore').querySelector('button.on')?.textContent, 'Wrong');
  assert.match(text(host), /once per thread every 5 minutes and up to 20 an hour/);
});

test('the repository row says when the source cannot read GitHub', async () => {
  const { host } = await open(
    okState({ source: { state: 'watching', repo: 'acme/widgets', health: { state: 'error', reason: 'No GitHub token' } } }),
  );
  assert.match(text(row(host, 'Repository')), /Can't read acme\/widgets: No GitHub token\. Trying again\./);
});

test('an empty log, an interrupted event and a measured precision', async () => {
  const { host } = await open(
    okState({
      log: [],
      reconcile: [{ source: 'github', externalId: 'x', committedAt: 1 }],
      stats: { total: 5, wouldAccept: 3, marked: 3, right: 2, wrong: 1, precision: 2 / 3 },
    }),
  );
  assert.match(text(row(host, 'Nothing yet')), /Events appear here as they arrive\./);
  assert.match(text(row(host, 'Interrupted')), /1 event may have run before a restart and need checking\./);
  assert.match(text(row(host, 'Precision')), /67% right \(2 of 3 marked\)/);
});

test('a rule mode is changed with one click; the mode it already has does nothing', async () => {
  const { host } = await open(okState());
  responses['superagent.setRule'] = () => Promise.resolve({});
  await click(button(row(host, 'Explicit requests'), 'Observe'));
  assert.equal(called('superagent.setRule').length, 0, 'already Observe');
  await click(button(row(host, 'Explicit requests'), 'Off'));
  await click(button(row(host, 'Reproduce bugs'), 'Observe'));
  assert.deepEqual(called('superagent.setRule'), [
    ['explicit', 'off'],
    ['bugs', 'observe'],
  ]);
});

test('the repository: Save sends what was typed, an empty field clears it, Enter saves, a refusal stays typed and is told', async () => {
  const { host } = await open(okState());
  const field = host.querySelector('input[aria-label="Repository"]') as HTMLInputElement;
  const save = () => button(row(host, 'Repository'), 'Save') as HTMLButtonElement;
  assert.equal(save().disabled, true, 'nothing to save');
  responses['superagent.setRepo'] = () => Promise.resolve({});
  await setValue(field, ' acme/gadgets ');
  assert.equal(save().disabled, false);
  await click(save());
  await setValue(field, '   ');
  await click(save());
  await setValue(field, 'other/repo');
  await key(field, { key: 'Enter' });
  assert.deepEqual(called('superagent.setRepo'), [[' acme/gadgets '], [null], ['other/repo']]);
  responses['superagent.setRepo'] = () => Promise.reject(new Error('Use owner/name, like mopilot-ai/mopilot-internal.'));
  await setValue(field, 'nope');
  await click(save());
  await flush();
  assert.deepEqual(toasts(), [['Use owner/name, like mopilot-ai/mopilot-internal.', 'error']]);
  assert.equal(field.value, 'nope', 'what was refused stays typed');
  await key(field, { key: 'Escape' });
  assert.equal(called('superagent.setRepo').length, 4, 'only Enter saves');
});

test('no repository yet: the field is empty, the line says to pick one, and a second Enter during a save sends nothing more', async () => {
  const { host } = await open(
    okState({ config: { ...okState().config, repo: null, allowed: [] }, source: { state: 'stopped', reason: 'no_repo' } }),
  );
  const field = host.querySelector('input[aria-label="Repository"]') as HTMLInputElement;
  assert.equal(field.value, '');
  assert.match(text(row(host, 'Repository')), /Pick a repository to start\./);
  let finish: (v: unknown) => void = () => {};
  responses['superagent.setRepo'] = () =>
    new Promise((r) => {
      finish = r;
    });
  await setValue(field, 'acme/widgets');
  await key(field, { key: 'Enter' });
  await key(field, { key: 'Enter' });
  assert.deepEqual(called('superagent.setRepo'), [['acme/widgets']], 'one save at a time');
  assert.equal((button(row(host, 'Repository'), 'Save') as HTMLButtonElement).disabled, true);
  finish({});
  await flush();
});

test('a saved field shows what is saved even when main cleaned the text into the value it already had', async () => {
  const { host } = await open(okState());
  responses['superagent.setAllowed'] = () => Promise.resolve({});
  const field = host.querySelector('input[aria-label="Allowed people"]') as HTMLInputElement;
  await setValue(field, 'alice,bob');
  await click(button(row(host, 'Allowed people'), 'Save'));
  await flush();
  assert.equal(field.value, 'alice, bob', 'back to the saved text');
  assert.equal((button(row(host, 'Allowed people'), 'Save') as HTMLButtonElement).disabled, true);
});

test('allowed people: the typed logins are split and sent', async () => {
  const { host } = await open(okState());
  responses['superagent.setAllowed'] = () => Promise.resolve({});
  const field = host.querySelector('input[aria-label="Allowed people"]') as HTMLInputElement;
  await setValue(field, 'alice, @carol  dave');
  await click(button(row(host, 'Allowed people'), 'Save'));
  assert.deepEqual(called('superagent.setAllowed'), [[['alice', '@carol', 'dave']]]);
});

test('Pause everything and Pause GitHub are switches saved through main', async () => {
  const { host } = await open(okState({ config: { ...okState().config, paused: { all: false, github: true } } }));
  responses['superagent.setPaused'] = () => Promise.resolve({});
  const sw = (title: string) => row(host, title).querySelector('[role=switch]') as HTMLElement;
  assert.equal(sw('Pause everything').getAttribute('aria-checked'), 'false');
  assert.equal(sw('Pause GitHub').getAttribute('aria-checked'), 'true');
  await click(sw('Pause everything'));
  await click(sw('Pause GitHub'));
  assert.deepEqual(called('superagent.setPaused'), [
    ['all', true],
    ['github', false],
  ]);
});

test('Right and Wrong mark an entry; marking the marked one takes it back', async () => {
  const { host } = await open(okState());
  responses['superagent.mark'] = () => Promise.resolve({});
  await click(button(row(host, 'Would accept'), 'Right'));
  await click(button(row(host, 'Would ignore'), 'Wrong'));
  await click(button(row(host, 'Would ignore'), 'Right'));
  assert.deepEqual(called('superagent.mark'), [
    ['d1', 'right'],
    ['d2', null],
    ['d2', 'right'],
  ]);
});

test('the page reads again when main says something changed', async () => {
  let onChanged: () => void = () => {};
  responses['superagent.onChanged'] = (cb: () => void) => {
    onChanged = cb;
    return () => {};
  };
  let log: any[] = [];
  const { host } = await open(() => okState({ log }));
  assert.match(text(host), /Nothing yet/);
  log = okState().log;
  await (await import('react')).act(async () => onChanged());
  await flush();
  assert.match(text(host), /Would accept/);
});

test('Settings nav: Superagent is listed and found only while the flag is on, and its page opens', async () => {
  useStore.setState({ route: { name: 'settings', section: 'general' } });
  const off = await render(h(Settings.Nav));
  assert.equal(
    [...off.host.querySelectorAll('.side-row-label')].some((e) => text(e) === 'Superagent'),
    false,
  );
  await off.unmount();

  ctl.flags.superagent = true;
  const nav = await render(h(Settings.Nav));
  assert.equal([...nav.host.querySelectorAll('.side-row-label')].filter((e) => text(e) === 'Superagent').length, 1);
  await setValue(nav.host.querySelector('.settings-search input')!, 'Allowed people');
  assert.ok(
    [...nav.host.querySelectorAll('.side-row-label')].some((e) => text(e).startsWith('Superagent')),
    'found by the words of its page',
  );
  await click([...nav.host.querySelectorAll('.side-row')].find((r) => text(r.querySelector('.side-row-label')).startsWith('Superagent'))!);
  assert.deepEqual(called('navigate').at(-1), [{ name: 'settings', section: 'superagent', find: 'Allowed people' }]);
  await nav.unmount();

  responses['superagent.state'] = () => Promise.resolve(okState());
  useStore.setState({ route: { name: 'settings', section: 'superagent' } });
  const page = await render(h(Settings, { section: 'superagent' }));
  await flush();
  assert.equal(text(page.host.querySelector('.settings-title')), 'Superagent');
  assert.match(text(page.host), /1\. Connect/);
  await page.unmount();

  ctl.flags.superagent = false;
  const gone = await render(h(Settings, { section: 'superagent' }));
  await flush();
  assert.notEqual(
    text(gone.host.querySelector('.settings-title')),
    'Superagent',
    'the flag off: the page is the one an unknown section gets',
  );
  assert.doesNotMatch(text(gone.host), /1\. Connect/);
});
