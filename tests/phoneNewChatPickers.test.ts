// New chat's chips and sheets: agents as the Mac lists them, the computer with its live dot, projects with their branch, Select model with Effort, Permissions and Account as its pages.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { act, flush, click } from './support/phone/component-kit';
import { scripted, fakeMedia, menus } from './support/phone/m3';
import { mount, has, button, chip, tap, typeIn, row } from './support/phone/newchat-kit';
const newChatPath = '../mobile/src/screens/NewChat';
const { greeting, projectChip } = await import(newChatPath);

test('the greeting uses the first word of the account name, and the project chip names its branch or the new worktree', () => {
  assert.equal(greeting('Dax Hill'), 'Back at it, Dax');
  assert.equal(greeting('  '), 'Back at it');
  assert.equal(greeting(undefined), 'Back at it');
  assert.equal(projectChip(undefined, false), 'No project');
  assert.equal(projectChip({ id: 'a', label: 'mopilot', branch: 'main' }, false), 'mopilot · main');
  assert.equal(projectChip({ id: 'a', label: 'mopilot', branch: null }, false), 'mopilot');
  assert.equal(projectChip({ id: 'a', label: 'mopilot', branch: 'main' }, true), 'mopilot · new worktree');
});

test('the agent sheet lists what the Mac reports with its line, and picking one reloads its menus', async () => {
  const { runtime, calls } = scripted((m) =>
    m === 'harnesses.list'
      ? { harnesses: [...menus.harnesses.harnesses, { id: 'acp:gemini', label: 'Gemini CLI', detail: 'Uses your Google login' }] }
      : m === 'options.get'
        ? {
            ...menus.options('claude'),
            models: [{ id: 'm1', label: 'Sonnet', description: 'Most efficient for simpler tasks', efforts: [] }],
            model: 'm1',
          }
        : undefined,
  );
  const { host } = await mount(runtime, fakeMedia().media);
  await tap(chip(host, 'Agent'));
  has(host, /Gemini CLIUses your Google login/);
  await click('Gemini CLI');
  assert.deepEqual(
    calls.filter((c) => c[0] === 'options.get').map((c) => c[1].harness),
    ['claude', 'acp:gemini'],
  );
  assert.ok(chip(host, 'Agent').textContent!.includes('Gemini CLI'));
  // a model's line comes from the Mac; a model with no efforts has no Effort row, and the pill no second word
  await click('Model, Sonnet');
  has(host, /SonnetMost efficient for simpler tasks/);
  assert.doesNotMatch(host.textContent!, /Effort/);
  await row('Sonnet');
  assert.doesNotMatch(host.textContent!, /Select model/);
});

test("a project the Mac reports a branch for shows it on the chip and under its row; an older Mac's project shows its name alone", async () => {
  const { runtime } = scripted((m) =>
    m === 'projects.list'
      ? {
          projects: [
            { id: 'app', name: 'mopilot', branch: 'main' },
            { id: 'old', name: 'Legacy' },
          ],
        }
      : undefined,
  );
  const { host } = await mount(runtime, fakeMedia().media);
  await tap(chip(host, 'Project'));
  has(host, /mopilotmain/);
  await row('mopilot');
  assert.equal(chip(host, 'Project').getAttribute('aria-label'), 'Project, mopilot · main');
  await tap(chip(host, 'Project'));
  await row('Legacy');
  assert.equal(chip(host, 'Project').getAttribute('aria-label'), 'Project, Legacy');
});

test('the computer chip shows the paired Mac with its live dot and opens a sheet naming it', async () => {
  const snap = { phase: 'online', selectedPair: 'p', pairs: [{ pairId: 'p', macId: 'm', name: 'Studio Mac' }], presence: {} };
  const { runtime } = scripted(() => undefined);
  const { host } = await mount(runtime, fakeMedia().media, {}, snap);
  const computer = chip(host, 'Computer');
  assert.ok(computer.textContent!.includes('Studio Mac'));
  await tap(computer);
  assert.ok(button(host, 'Studio Mac, Connected'));
  has(host, /Change computers in Settings/);
  await click('Studio Mac, Connected');
  assert.doesNotMatch(host.textContent!, /Change computers/);
  const away = await mount(runtime, fakeMedia().media, {}, { ...snap, presence: { p: { state: 'sleeping', lastSeen: 1 } } });
  await tap(chip(away.host, 'Computer'));
  assert.ok(button(away.host, 'Studio Mac, Offline'));
});

test('menus the Mac does not return are hidden, and no agent is an honest empty state', async () => {
  const none = scripted((m) => (m === 'harnesses.list' ? { harnesses: [] } : m === 'projects.list' ? { projects: [] } : undefined));
  const a = await mount(none.runtime, fakeMedia().media);
  has(a.host, /No agent is ready on your computer/);
  assert.equal(chip(a.host, 'Agent'), undefined);
  assert.equal(chip(a.host, 'Project'), undefined);
  const bare = scripted((m) =>
    m === 'projects.list' ? { projects: [] } : m === 'options.get' ? { models: [], permission: null } : undefined,
  );
  const b = await mount(bare.runtime, fakeMedia().media);
  assert.equal(chip(b.host, 'Model'), undefined, 'no models: no pill');
  assert.ok(chip(b.host, 'Agent'));
});

test('a model sheet with no models still opens its rows; a picked model whose efforts lack the current one takes its default', async () => {
  const { runtime, calls } = scripted((m) =>
    m === 'options.get'
      ? {
          ...menus.options('claude'),
          models: [
            { id: 'a', label: 'A', efforts: [{ id: 'low', label: 'Low' }], defaultEffort: 'low' },
            { id: 'b', label: 'B', efforts: [{ id: 'max', label: 'Max' }], defaultEffort: 'max' },
            { id: 'c', label: 'C', efforts: [{ id: 'low', label: 'Low' }] },
          ],
          model: 'a',
          effort: 'low',
        }
      : m === 'chat.start'
        ? { chatId: 'x' }
        : undefined,
  );
  const { host } = await mount(runtime, fakeMedia().media);
  await click('Model, A Low');
  await row('B');
  assert.ok(button(host, 'Model, B Max'));
  await click('Model, B Max');
  await row('C');
  // C has no default: none is sent and the pill has no second word
  assert.ok(button(host, 'Model, C'));
  await typeIn('go');
  await click('Start chat');
  assert.equal(calls.find((c) => c[0] === 'chat.start')![1].effort ?? null, null);
});

test('an older menu answer arriving after a newer pick, success or failure, is ignored', async () => {
  const pending = new Map<string, { ok: (v: unknown) => void; no: (e: Error) => void }>();
  const { runtime } = scripted((m, p) =>
    m === 'options.get' && p.harness === 'claude' ? new Promise((ok, no) => pending.set('claude', { ok, no })) : undefined,
  );
  const { host } = await mount(runtime, fakeMedia().media);
  await tap(chip(host, 'Agent'));
  await click('Codex');
  assert.ok(button(host, 'Model, codex model Low'));
  await act(async () => pending.get('claude')!.ok({ models: [{ id: 'stale', label: 'stale model' }], model: 'stale' }));
  await flush();
  assert.doesNotMatch(host.textContent!, /stale model/);
  await tap(chip(host, 'Agent'));
  await click('Claude Code');
  await tap(chip(host, 'Agent'));
  await click('Codex');
  await act(async () => pending.get('claude')!.no(new Error('stale failure')));
  await flush();
  assert.doesNotMatch(host.textContent!, /stale failure/);
});

test('the account is a page of Select model only when offered, the worktree a switch in Project, both sent, and a retry keeps the start id', async () => {
  let attempts = 0;
  const { runtime, calls } = scripted((m) => {
    if (m === 'chat.start' && ++attempts === 1) throw new Error('Computer is offline');
    return m === 'chat.start' ? { chatId: 'claude:wt' } : undefined;
  });
  const { host, opened } = await mount(runtime, fakeMedia().media);
  await click('Model, claude model Low');
  await click('Account, Automatic');
  has(host, /Work/);
  has(host, /Old.*Sign in on your Mac/);
  assert.equal(button(host, 'Old'), undefined, 'a signed-out login is listed and cannot be picked');
  await click('Work');
  assert.ok(button(host, 'Account, Work'));
  await click('Close');
  await tap(chip(host, 'Project'));
  assert.equal(host.querySelector('[aria-label="New worktree"]'), null, 'no worktree without a project');
  await click('App');
  await tap(chip(host, 'Project'));
  has(host, /New worktree/);
  const toggle = host.querySelector('[aria-label="New worktree"]') as HTMLElement;
  await act(async () => toggle.dispatchEvent(new Event('click', { bubbles: true })));
  await flush();
  await click('Close');
  assert.ok(chip(host, 'Project').textContent!.includes('App · new worktree'), 'the project chip says where it will work');
  await typeIn('Go');
  await click('Start chat');
  has(host, /offline or asleep/);
  await click('Start chat');
  const starts = calls.filter((c) => c[0] === 'chat.start').map((c) => c[1]);
  assert.equal(starts.length, 2);
  assert.equal(starts[0].startId, starts[1].startId);
  assert.deepEqual([starts[1].account, starts[1].worktree, starts[1].projectId], ['work', true, 'app']);
  assert.deepEqual(opened, ['claude:wt']);
});

test('picking the default account again sends none, and no Account row shows for a harness without logins', async () => {
  const { runtime, calls } = scripted((m) => (m === 'chat.start' ? { chatId: 'c' } : undefined));
  const { host } = await mount(runtime, fakeMedia().media);
  await click('Model, claude model Low');
  await click('Account, Automatic');
  await click('Work');
  await click('Account, Work');
  await click('Automatic');
  assert.ok(button(host, 'Account, Automatic'));
  await click('Close');
  await typeIn('x');
  await click('Start chat');
  assert.equal(calls.find((c) => c[0] === 'chat.start')![1].account ?? null, null);
  await tap(chip(host, 'Agent'));
  await click('Codex');
  await click('Model, codex model Low');
  assert.equal(button(host, 'Account, Automatic'), undefined);
});

test('clearing the project also clears the worktree choice', async () => {
  const { runtime, calls } = scripted((m) => (m === 'chat.start' ? { chatId: 'c' } : undefined));
  const { host } = await mount(runtime, fakeMedia().media);
  await tap(chip(host, 'Project'));
  await click('App');
  await tap(chip(host, 'Project'));
  await act(async () =>
    (host.querySelector('[aria-label="New worktree"]') as HTMLElement).dispatchEvent(new Event('click', { bubbles: true })),
  );
  await click('No project');
  await tap(chip(host, 'Project'));
  await click('App');
  assert.ok(chip(host, 'Project').textContent!.endsWith('App'));
  await typeIn('x');
  await click('Start chat');
  assert.equal('worktree' in calls.find((c) => c[0] === 'chat.start')![1], false);
});

test('when every permission is closed to the phone none is picked: the row says Choose and Start waits', async () => {
  const { runtime } = scripted((m) =>
    m === 'options.get'
      ? {
          ...menus.options('claude'),
          permission: {
            value: 'full-access',
            rows: [{ id: 'auto-review', label: 'Auto', detail: 'Reviewed', disabled: 'Not for this model' }],
          },
        }
      : undefined,
  );
  const { host } = await mount(runtime, fakeMedia().media);
  await click('Model, claude model Low');
  assert.ok(button(host, 'Permissions, Choose'));
  await click('Close');
  await typeIn('go');
  assert.equal(button(host, 'Start chat')!.disabled, true);
});

test('the + sheet closes on ✕ without adding anything', async () => {
  const { runtime } = scripted(() => undefined);
  const { host } = await mount(runtime, fakeMedia().media);
  await click('Add to session');
  has(host, /Add to session/);
  await click('Close');
  assert.doesNotMatch(host.textContent!, /Add to session|photo\.jpg/);
});
