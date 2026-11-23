// The native apps that also run scheduled tasks (electron/platform/nativeSchedulers.cjs):
// what it ran (the Codex app's sqlite, Claude Desktop's scheduled-tasks.json), recording MoPilot's runs there,
// and registering MoPilot's Claude Code tasks in Claude Desktop.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const require = createRequire(import.meta.url);
const { codexApp, claudeDesktop, claudeAppData, parseSkill } = require('../electron/platform/nativeSchedulers.cjs');

function tmp(t: any) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'native-'));
  t.after(() => fs.rmSync(d, { recursive: true, force: true }));
  return d;
}

/** A Codex app database with the columns the app has today. */
function codexDb(home: string, rows: any[] = [], { columns = true } = {}) {
  fs.mkdirSync(path.join(home, 'sqlite'), { recursive: true });
  const db = new DatabaseSync(path.join(home, 'sqlite', 'codex-dev.db'));
  db.exec(
    columns
      ? 'CREATE TABLE automations (id TEXT PRIMARY KEY, name TEXT, status TEXT, last_run_at INTEGER, next_run_at INTEGER, next_run_nominal_at INTEGER)'
      : 'CREATE TABLE automations (id TEXT PRIMARY KEY, status TEXT)',
  );
  db.exec('CREATE TABLE automation_runs (thread_id TEXT PRIMARY KEY, automation_id TEXT, created_at INTEGER)');
  const put = db.prepare(
    'INSERT INTO automations (id, status' +
      (columns ? ', last_run_at, next_run_at, next_run_nominal_at' : '') +
      ') VALUES (?, ?' +
      (columns ? ', ?, ?, ?' : '') +
      ')',
  );
  for (const r of rows) columns ? put.run(r.id, r.status, r.last ?? null, r.next ?? null, r.nominal ?? null) : put.run(r.id, r.status);
  return db;
}

test('Codex app: not installed reads as nothing ran; installed reads what it handled', async (t) => {
  const home = tmp(t);
  const app = codexApp({ codexHome: () => home, processes: async () => '' });
  assert.equal(app.installed(), false);
  assert.deepEqual(app.read(), { ok: true, tasks: new Map() });
  assert.deepEqual(app.runs('x'), []);
  assert.equal(await app.running(), false);
  const db = codexDb(home, [
    { id: 'daily', status: 'ACTIVE', last: 900, next: 2010, nominal: 2000 },
    { id: 'paused', status: 'PAUSED', last: 500 },
    { id: 'new', status: 'ACTIVE' },
  ]);
  db.prepare('INSERT INTO automation_runs VALUES (?, ?, ?)').run('th-1', 'daily', 800);
  db.prepare('INSERT INTO automation_runs VALUES (?, ?, ?)').run('th-2', 'daily', 950);
  db.close();
  assert.equal(app.installed(), true);
  const r = app.read();
  assert.equal(r.ok, true);
  assert.deepEqual(Object.fromEntries(r.tasks), {
    daily: { active: true, through: 1999 },
    paused: { active: false, through: 500 },
    new: { active: true, through: 0 },
  });
  assert.deepEqual(
    app.runs('daily').map((x: any) => [x.chatId, x.scheduledFor, x.by]),
    [
      ['th-2', 950, 'codex-app'],
      ['th-1', 800, 'codex-app'],
    ],
  );
  // MoPilot ran 2000: the app's next time moves on
  assert.equal(app.markHandled('daily', 2000, 3000, 2100), true);
  assert.deepEqual(app.read().tasks.get('daily'), { active: true, through: 2999 });
  const check = new DatabaseSync(path.join(home, 'sqlite', 'codex-dev.db'));
  assert.deepEqual(
    { ...check.prepare('SELECT last_run_at, next_run_at FROM automations WHERE id = ?').get('daily') },
    { last_run_at: 2100, next_run_at: 3000 },
  );
  check.close();
  assert.equal(app.markHandled('unknown', 1, 2, 3), false, 'no row: nothing recorded');
});

test('Codex app: a schema it does not recognize is {ok: false} and is never written', async (t) => {
  const home = tmp(t);
  codexDb(home, [{ id: 'a', status: 'ACTIVE' }], { columns: false }).close();
  const app = codexApp({ codexHome: () => home });
  assert.deepEqual(app.read(), { ok: false, tasks: new Map() });
  assert.equal(app.markHandled('a', 1, 2, 3), false);
  // a database that doesn't open
  const broken = tmp(t);
  fs.mkdirSync(path.join(broken, 'sqlite'));
  fs.writeFileSync(path.join(broken, 'sqlite', 'codex-dev.db'), 'not a database');
  const b = codexApp({ codexHome: () => broken });
  assert.equal(b.read().ok, false);
  assert.deepEqual(b.runs('a'), []);
  // the real process list
  assert.equal(typeof (await b.running()), 'boolean');
});

test('Claude Desktop data folder per platform', () => {
  assert.equal(claudeAppData('darwin', {}, '/Users/me'), '/Users/me/Library/Application Support/Claude');
  assert.equal(claudeAppData('win32', { APPDATA: 'C:\\R' }, 'C:\\me'), path.join('C:\\R', 'Claude'));
  assert.equal(claudeAppData('win32', {}, '/me'), path.join('/me', 'AppData', 'Roaming', 'Claude'));
  assert.equal(claudeAppData('linux', { XDG_CONFIG_HOME: '/x' }, '/me'), '/x/Claude');
  assert.equal(claudeAppData('linux', {}, '/me'), '/me/.config/Claude');
  assert.equal(typeof claudeAppData(), 'string');
});

test('SKILL.md: frontmatter and the prompt after it', () => {
  assert.deepEqual(parseSkill('---\nname: x\ndescription: Do it\nbad line\n---\n\nThe prompt\n'), {
    meta: { name: 'x', description: 'Do it' },
    prompt: 'The prompt',
  });
  assert.deepEqual(parseSkill('Just a prompt'), { meta: {}, prompt: 'Just a prompt' });
});

/** A Claude Desktop data folder signed in to account `acct`, with these orgs. */
function desktopData(root: string, orgs: string[], acct = 'acct') {
  const app = path.join(root, 'Claude');
  fs.mkdirSync(path.join(app, 'claude-code-sessions', acct), { recursive: true });
  fs.writeFileSync(path.join(app, 'config.json'), JSON.stringify({ lastKnownAccountUuid: acct }));
  for (const o of orgs) fs.mkdirSync(path.join(app, 'claude-code-sessions', acct, o));
  return app;
}
const storeOf = (app: string, org: string, acct = 'acct') => path.join(app, 'claude-code-sessions', acct, org, 'scheduled-tasks.json');

test('Claude Desktop: lists its tasks, reads what it ran, and records what MoPilot ran', async (t) => {
  const root = tmp(t);
  const app = desktopData(root, ['org']);
  const tasks = path.join(root, 'scheduled-tasks');
  fs.mkdirSync(path.join(tasks, 'daily'), { recursive: true });
  fs.writeFileSync(path.join(tasks, 'daily', 'SKILL.md'), '---\nname: daily\ndescription: Daily\n---\n\nReview the repo\n');
  fs.writeFileSync(
    storeOf(app, 'org'),
    JSON.stringify({
      scheduledTasks: [
        {
          id: 'daily',
          displayName: 'Daily review',
          cronExpression: '0 9 * * *',
          enabled: true,
          filePath: path.join(tasks, 'daily', 'SKILL.md'),
          createdAt: 10,
          lastScheduledFor: '2026-10-12T16:00:00.000Z',
          cwd: '/proj',
          useWorktree: true,
        },
        { id: 'odd', cronExpression: '0 9 1 * *', enabled: false },
      ],
      recordedSkips: {},
    }),
  );
  const d = claudeDesktop({ appData: () => app, tasksDir: () => tasks, processes: async () => '' });
  assert.equal(d.installed(), true);
  assert.equal(await d.running(), false);
  assert.deepEqual(Object.fromEntries(d.read().tasks), {
    daily: { active: true, through: Date.parse('2026-10-12T16:00:00.000Z') },
    odd: { active: false, through: 0 },
  });
  const errors: string[] = [];
  const [daily, odd] = d.list((m: string) => errors.push(m));
  // a task whose SKILL.md can't be read still lists, and says why
  assert.equal(errors.length, 1);
  assert.match(errors[0], /^Couldn't read the prompt of Claude Desktop task "odd": ENOENT/);
  assert.deepEqual(daily, {
    version: 1,
    id: 'daily',
    kind: 'cron',
    name: 'Daily review',
    prompt: 'Review the repo',
    status: 'ACTIVE',
    rrule: 'FREQ=DAILY;BYHOUR=9;BYMINUTE=0',
    cron: '0 9 * * *',
    harness: 'claude',
    execution_environment: 'worktree',
    cwds: ['/proj'],
    created_at: 10,
  });
  // a cron MoPilot can't read lists with no rule; no SKILL.md lists with no prompt
  assert.equal(odd.rrule, '');
  assert.equal(odd.prompt, '');
  assert.equal(odd.name, 'odd');
  assert.equal(odd.status, 'PAUSED');
  assert.equal(odd.created_at, undefined);
  assert.equal(d.markHandled('daily', Date.parse('2026-10-13T16:00:00.000Z'), null, Date.parse('2026-10-13T16:01:00.000Z')), true);
  const after = JSON.parse(fs.readFileSync(storeOf(app, 'org'), 'utf8'));
  assert.equal(after.scheduledTasks[0].lastScheduledFor, '2026-10-13T16:00:00.000Z');
  assert.equal(after.scheduledTasks[0].lastRunAt, '2026-10-13T16:01:00.000Z');
  assert.deepEqual(after.recordedSkips, {}, 'the rest of the store is kept');
  assert.equal(d.markHandled('missing', 1, null, 2), false);
});

test('Claude Desktop: not installed, no account, several orgs, an unknown store shape', (t) => {
  const root = tmp(t);
  const none = claudeDesktop({ appData: () => path.join(root, 'nothing') });
  assert.equal(none.installed(), false);
  assert.deepEqual(none.read(), { ok: true, tasks: new Map() });
  const never = () => assert.fail('nothing to report');
  assert.deepEqual(none.list(never), []);
  // signed out: no account to tell the store by
  const app = desktopData(root, ['a', 'b']);
  fs.writeFileSync(path.join(app, 'config.json'), '{}');
  const d = claudeDesktop({ appData: () => app, tasksDir: () => path.join(root, 'tasks') });
  assert.equal(d.read().ok, false);
  assert.deepEqual(d.list(never), [], 'a store it can’t tell lists nothing');
  assert.equal(d.markHandled('x', 1, null, 2), false);
  assert.deepEqual(d.upsert({ id: 'x', rrule: 'FREQ=DAILY;BYHOUR=9;BYMINUTE=0' }), { ok: false, reason: 'store' });
  assert.equal(d.remove('x'), false);
  // an account folder that isn't there
  fs.writeFileSync(path.join(app, 'config.json'), JSON.stringify({ lastKnownAccountUuid: 'other' }));
  assert.equal(d.read().ok, false);
  // two orgs and no store yet: which one is unknown
  fs.writeFileSync(path.join(app, 'config.json'), JSON.stringify({ lastKnownAccountUuid: 'acct' }));
  assert.equal(d.read().ok, false);
  // the org with a store is the one; the newest when both have one
  fs.writeFileSync(storeOf(app, 'a'), JSON.stringify({ scheduledTasks: [{ id: 'from-a', cronExpression: '* * * * *' }] }));
  assert.deepEqual([...d.read().tasks.keys()], ['from-a']);
  fs.writeFileSync(storeOf(app, 'b'), JSON.stringify({ scheduledTasks: [{ id: 'from-b', cronExpression: '* * * * *' }] }));
  fs.utimesSync(storeOf(app, 'a'), new Date(1000), new Date(1000));
  assert.deepEqual([...d.read().tasks.keys()], ['from-b']);
  fs.writeFileSync(storeOf(app, 'b'), JSON.stringify({ scheduledTasks: [{ id: 1 }] }));
  assert.equal(d.read().ok, false, 'a shape it does not know');
  fs.writeFileSync(storeOf(app, 'b'), JSON.stringify({ tasks: [] }));
  assert.equal(d.read().ok, false);
  fs.writeFileSync(storeOf(app, 'b'), 'null');
  assert.equal(d.read().ok, false);
});

test('Claude Desktop rejects task directory boundaries in imported and direct operations', (t) => {
  const root = tmp(t);
  const app = desktopData(root, ['org']);
  const tasks = path.join(root, 'tasks');
  const d = claudeDesktop({ appData: () => app, tasksDir: () => tasks });
  const file = path.join(app, 'claude-code-sessions', 'acct', 'org', 'scheduled-tasks.json');
  const marker = path.join(root, 'keep.txt');
  fs.writeFileSync(marker, 'keep');
  for (const id of ['', '.', '..', '../other', 'a/b', 'a\\b']) {
    fs.writeFileSync(file, JSON.stringify({ scheduledTasks: [{ id, cronExpression: '0 9 * * *' }] }));
    assert.deepEqual(
      d.list(() => {}),
      [],
    );
    assert.equal(d.read().ok, false);
    fs.writeFileSync(file, JSON.stringify({ scheduledTasks: [] }));
    assert.throws(() => d.remove(id), /isn't a task id/);
    assert.throws(() => d.upsert({ id, rrule: 'FREQ=DAILY;BYHOUR=9;BYMINUTE=0' }), /isn't a task id/);
    assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { scheduledTasks: [] });
    assert.equal(fs.readFileSync(marker, 'utf8'), 'keep');
  }
});

test('Claude Desktop: MoPilot registers, updates and removes its Claude Code tasks', (t) => {
  const root = tmp(t);
  const app = desktopData(root, ['org']);
  const tasks = path.join(root, 'tasks');
  const d = claudeDesktop({ appData: () => app, tasksDir: () => tasks });
  assert.deepEqual(d.read(), { ok: true, tasks: new Map() }, 'the one org, no store yet');
  const task = {
    id: 'review',
    name: 'Review: PRs',
    prompt: 'Look at open PRs',
    status: 'ACTIVE',
    rrule: 'FREQ=WEEKLY;BYDAY=MO;BYHOUR=9;BYMINUTE=0',
    cwds: ['/proj'],
    execution_environment: 'local',
    created_at: 42,
  };
  assert.deepEqual(d.upsert(task), { ok: true });
  const store = () => JSON.parse(fs.readFileSync(storeOf(app, 'org'), 'utf8')).scheduledTasks;
  assert.deepEqual(store(), [
    {
      id: 'review',
      displayName: 'Review: PRs',
      cronExpression: '0 9 * * 1',
      enabled: true,
      filePath: path.join(tasks, 'review', 'SKILL.md'),
      createdAt: 42,
      cwd: '/proj',
      useWorktree: false,
    },
  ]);
  assert.equal(
    fs.readFileSync(path.join(tasks, 'review', 'SKILL.md'), 'utf8'),
    '---\nname: review\ndescription: "Review: PRs"\n---\n\nLook at open PRs\n',
  );
  // Desktop's own keys are kept on an update
  const s = JSON.parse(fs.readFileSync(storeOf(app, 'org'), 'utf8'));
  s.scheduledTasks[0].notifySessionId = 'n1';
  fs.writeFileSync(storeOf(app, 'org'), JSON.stringify(s));
  assert.deepEqual(
    d.upsert({ ...task, status: 'PAUSED', name: '', prompt: undefined, cwds: undefined, execution_environment: 'worktree' }),
    { ok: true },
  );
  assert.deepEqual(
    { ...store()[0], filePath: undefined },
    {
      id: 'review',
      displayName: 'review',
      cronExpression: '0 9 * * 1',
      enabled: false,
      filePath: undefined,
      createdAt: 42,
      cwd: '/proj',
      useWorktree: true,
      notifySessionId: 'n1',
    },
  );
  assert.match(fs.readFileSync(path.join(tasks, 'review', 'SKILL.md'), 'utf8'), /description: review\n---\n\n\n$/);
  // a schedule cron can't say stays out
  assert.deepEqual(d.upsert({ id: 'odd', rrule: 'FREQ=MINUTELY;INTERVAL=7' }), { ok: false, reason: 'schedule' });
  assert.deepEqual(d.upsert({ id: 'odd' }), { ok: false, reason: 'schedule' });
  // a new one with no created_at is stamped now
  d.upsert({ id: 'n', rrule: 'FREQ=DAILY;BYHOUR=1;BYMINUTE=0', status: 'ACTIVE' });
  assert.ok(store().find((x: any) => x.id === 'n').createdAt > 1e12);
  assert.equal(d.remove('review'), true);
  assert.deepEqual(
    store().map((x: any) => x.id),
    ['n'],
  );
  assert.equal(fs.existsSync(path.join(tasks, 'review')), false);
  assert.equal(d.remove('never-there'), true, 'nothing to take out');
});

test('Claude Desktop: the default tasks folder follows CLAUDE_CONFIG_DIR', async (t) => {
  const root = tmp(t);
  const app = desktopData(root, ['org']);
  const prev = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = path.join(root, 'cfg');
  t.after(() => (prev === undefined ? delete process.env.CLAUDE_CONFIG_DIR : (process.env.CLAUDE_CONFIG_DIR = prev)));
  const d = claudeDesktop({ appData: () => app });
  d.upsert({ id: 'x', rrule: 'FREQ=DAILY;BYHOUR=1;BYMINUTE=0' });
  assert.equal(fs.existsSync(path.join(root, 'cfg', 'scheduled-tasks', 'x', 'SKILL.md')), true);
  assert.equal(typeof claudeDesktop().installed(), 'boolean', 'the real data folder');
  // with no CLAUDE_CONFIG_DIR the tasks are under ~/.claude; Desktop's process is read from the real list
  delete process.env.CLAUDE_CONFIG_DIR;
  const prevHome = process.env.HOME;
  process.env.HOME = path.join(root, 'home');
  t.after(() => (process.env.HOME = prevHome));
  const h = claudeDesktop({ appData: () => app });
  h.upsert({ id: 'y', rrule: 'FREQ=DAILY;BYHOUR=1;BYMINUTE=0' });
  assert.equal(fs.existsSync(path.join(root, 'home', '.claude', 'scheduled-tasks', 'y', 'SKILL.md')), true);
  assert.equal(typeof (await h.running()), 'boolean');
});

test('Codex app: an invalid handled-time watermark makes the schedule store unrecognized', (t) => {
  for (const row of [{ nominal: 'Infinity' }, { last: 'Infinity' }, { nominal: '1e100' }, { nominal: '' }, { last: '   ' }]) {
    const home = tmp(t);
    const db = codexDb(home, [{ id: 'daily', status: 'ACTIVE', ...row }]);
    db.close();
    const app = codexApp({ codexHome: () => home, processes: async () => '' });
    assert.deepEqual(app.read(), { ok: false, tasks: new Map() });
  }
});

test('Claude Desktop: a malformed handled date cannot be treated as never run', (t) => {
  const app = desktopData(tmp(t), ['org']);
  const file = storeOf(app, 'org');
  const desktop = claudeDesktop({ appData: () => app, tasksDir: () => '/unused', processes: async () => '' });
  for (const lastScheduledFor of ['not a date', '', 1000]) {
    const before = JSON.stringify({ scheduledTasks: [{ id: 'daily', cronExpression: '0 9 * * *', lastScheduledFor }] });
    fs.writeFileSync(file, before);
    assert.deepEqual(desktop.read(), { ok: false, tasks: new Map() });
    assert.equal(desktop.markHandled('daily', 1000, null, 2000), false);
    assert.equal(fs.readFileSync(file, 'utf8'), before);
  }
});

test('strict Claude task listing rejects unreadable native state and target prompts, but tolerates unrelated prompt failures', (t) => {
  const root = tmp(t);
  const app = desktopData(root, ['org']);
  const tasks = path.join(root, 'tasks');
  const d = claudeDesktop({ appData: () => app, tasksDir: () => tasks });
  const file = storeOf(app, 'org');
  fs.writeFileSync(file, '{ broken');
  assert.throws(() => d.list(() => {}, 'target'), /Claude Desktop.*unreadable/);
  assert.deepEqual(
    d.list(() => {}),
    [],
    'ordinary listing retains its existing degraded behavior',
  );
  fs.writeFileSync(
    file,
    JSON.stringify({
      scheduledTasks: [
        { id: 'target', cronExpression: '0 9 * * *' },
        { id: 'other', cronExpression: '0 9 * * *' },
      ],
    }),
  );
  assert.throws(() => d.list(() => {}, 'target'), /ENOENT/);
  fs.mkdirSync(path.join(tasks, 'target'), { recursive: true });
  fs.writeFileSync(path.join(tasks, 'target', 'SKILL.md'), '---\nname: target\n---\n\nKeep this prompt');
  const errors: string[] = [];
  assert.equal(d.list((message: string) => errors.push(message), 'target')[0].prompt, 'Keep this prompt');
  assert.equal(errors.length, 1);
  assert.match(errors[0], /other/);
  assert.deepEqual(
    claudeDesktop({ appData: () => path.join(root, 'absent') }).list(() => {}, 'target'),
    [],
  );
});

test('atomic edits preserve local Claude fallback but refuse unreadable canonical native fields', async (t) => {
  const { AutomationStore, writeTask } = require('../electron/platform/automationStore.cjs');
  const root = tmp(t);
  const app = desktopData(root, ['org']);
  const tasks = path.join(root, 'tasks');
  const desktop = claudeDesktop({ appData: () => app, tasksDir: () => tasks, processes: async () => '' });
  const file = storeOf(app, 'org');
  fs.writeFileSync(file, '{ broken');
  const store = new AutomationStore({
    codexDir: () => path.join(root, 'codex'),
    mopilotDir: () => path.join(root, 'mopilot'),
    desktop,
    codexApp: {},
  });
  const base = {
    id: 'task',
    name: 'Old',
    prompt: 'Keep local prompt',
    harness: 'claude',
    status: 'ACTIVE',
    rrule: 'FREQ=DAILY;BYHOUR=9;BYMINUTE=0',
  };
  for (const state of ['pending', 'unavailable', 'unsupported-schedule', undefined]) {
    await writeTask(store.o.mopilotDir(), { ...base, claude_desktop: state });
    const edited = await store.update('task', { name: 'Renamed' });
    assert.equal(edited.name, 'Renamed', String(state));
    assert.equal(edited.prompt, 'Keep local prompt', String(state));
  }
  for (const state of ['registered', 'missing']) {
    await writeTask(store.o.mopilotDir(), { ...base, claude_desktop: state });
    await assert.rejects(store.update('task', { name: 'Lost' }), /Claude Desktop.*unreadable/);
  }
  await writeTask(store.o.codexDir(), { ...base, id: 'codex', harness: 'codex' });
  assert.equal((await store.update('codex', { name: 'Healthy' })).name, 'Healthy');
  await writeTask(store.o.mopilotDir(), { ...base, id: 'basic', harness: 'acp:opencode' });
  assert.equal((await store.update('basic', { name: 'Healthy' })).name, 'Healthy');
  fs.writeFileSync(file, JSON.stringify({ scheduledTasks: [{ id: 'task', cronExpression: '0 9 * * *' }] }));
  await writeTask(store.o.mopilotDir(), { ...base, claude_desktop: 'unavailable' });
  await assert.rejects(store.update('task', { name: 'Lost' }), /ENOENT/);
  assert.equal((await store.list()).tasks.find((a: any) => a.id === 'task').name, 'task', 'ordinary listing remains permissive');
});
