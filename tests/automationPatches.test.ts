// Concurrent scheduled-task edits exercise the real store through the shared chat-tool entrypoint.
import { test, assert, setup, base, require, fs, path } from './support/automation-store/fixture.ts';
const { registerScheduledTaskTools } = require('../../../electron/capabilities/tools/scheduledTasks.cjs');

function toolsFor(store: any) {
  const handlers = new Map<string, any>();
  const changes: any[] = [];
  registerScheduledTaskTools(
    {
      register: (tool: any) => {
        handlers.set(tool.name, tool.handler);
        return () => {};
      },
    },
    {
      store,
      owner: (ctx: any) => ctx.chatId,
      harnessOf: () => 'codex',
      cwdOf: async () => null,
      nextRun: () => null,
      changed: (event: any) => changes.push(event),
    },
  );
  return { update: (patch: any, chatId = 'codex-chat') => handlers.get('update_scheduled_task')(patch, { chatId }), changes };
}

for (const harness of ['codex', 'claude', 'acp:opencode']) {
  test(`${harness}: independent tool patches survive while the task mutation queue waits`, async (t) => {
    const m = setup(t);
    const task = await m.store.save({ ...base, id: 'task', harness, name: 'Old name', prompt: 'Old prompt' });
    const tools = toolsFor(m.store);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const blocker = m.store.mutate(task.id, () => gate);
    const mutate = m.store.mutate.bind(m.store);
    let queued = 0;
    let ready!: () => void;
    const admitted = new Promise<void>((resolve) => {
      ready = resolve;
    });
    m.store.mutate = (id: string, action: any) => {
      const result = mutate(id, action);
      if (++queued === 2) ready();
      return result;
    };
    const a = tools.update({ id: task.id, name: 'New name' });
    const b = tools.update({ id: task.id, prompt: 'New prompt' }, 'claude-chat');
    await admitted;
    release();
    await Promise.all([blocker, a, b]);
    const saved = await m.store.get(task.id);
    assert.equal(saved.name, 'New name');
    assert.equal(saved.prompt, 'New prompt');
    assert.equal(tools.changes.length, 2);
  });
}

test('a named patch preserves newer permissions and heartbeat metadata at queue admission', async (t) => {
  const m = setup(t);
  const task = await m.store.save({ ...base, id: 'task', kind: 'heartbeat', name: 'Before', computer_control: true });
  const tools = toolsFor(m.store);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const blocker = m.store.mutate(task.id, async () => {
    await gate;
    await m.store.saveTask({ ...task, computer_control: false, on_approval: 'skip', target_thread_id: 'remembered-chat' });
  });
  const mutate = m.store.mutate.bind(m.store);
  let ready!: () => void;
  const admitted = new Promise<void>((resolve) => {
    ready = resolve;
  });
  m.store.mutate = (id: string, action: any) => {
    const pending = mutate(id, action);
    ready();
    return pending;
  };
  const update = tools.update({ id: task.id, name: 'After' });
  await admitted;
  release();
  await Promise.all([blocker, update]);
  const saved = await m.store.get(task.id);
  assert.equal(saved.name, 'After');
  assert.equal(saved.computer_control, false);
  assert.equal(saved.on_approval, 'skip');
  assert.equal(saved.target_thread_id, 'remembered-chat');
});

test('patch validation protects identity and clears optional fields without losing other fields', async (t) => {
  const m = setup(t);
  await m.store.save({ ...base, id: 'task', name: 'Before', model: 'old' });
  for (const bad of [null, undefined, [], 'bad', 1]) await assert.rejects(m.store.update('task', bad), /patch is needed/);
  await assert.rejects(m.store.update('../outside', {}), /isn't a task id/);
  const saved = await m.store.update('task', { id: 'redirect', model: undefined, name: 'After' });
  assert.equal(saved.id, 'task');
  assert.equal(saved.model, undefined);
  assert.equal(await m.store.get('redirect'), null);
  assert.equal(await m.store.update('missing', {}), null);
  await assert.rejects(toolsFor(m.store).update({ id: 'missing' }), /No scheduled task/);
});

test('deleted and unreadable targets reject rather than recreate or replace stored input', async (t) => {
  const m = setup(t);
  const a = await m.store.save({ ...base, id: 'task', name: 'Before' });
  const tools = toolsFor(m.store);
  const file = path.join(m.root, 'codex', 'task', 'automation.toml');
  fs.writeFileSync(file, 'broken = [');
  await assert.rejects(tools.update({ id: 'task', name: 'After' }));
  assert.equal(fs.readFileSync(file, 'utf8'), 'broken = [');
  assert.equal(tools.changes.length, 0);
  await m.store.save(a);
  await m.store.remove('task');
  await assert.rejects(tools.update({ id: 'task', name: 'After' }), /No scheduled task/);
  assert.equal(m.has('codex', 'task'), false);
  assert.equal(tools.changes.length, 0);
});

test('a failed patch releases the queue, accepted later fields survive and retry remains usable', async (t) => {
  const m = setup(t);
  await m.store.save({ ...base, id: 'task', name: 'Before', prompt: 'Original' });
  const tools = toolsFor(m.store);
  const rename = fs.renameSync;
  let fail = true;
  t.mock.method(fs, 'renameSync', (...args: any[]) => {
    if (fail) {
      fail = false;
      throw new Error('denied write');
    }
    return (rename as any)(...args);
  });
  const failed = tools.update({ id: 'task', name: 'Retry me' });
  const accepted = tools.update({ id: 'task', prompt: 'Accepted' });
  await assert.rejects(failed, /denied write/);
  await accepted;
  assert.equal((await m.store.get('task')).name, 'Before');
  assert.equal((await m.store.get('task')).prompt, 'Accepted');
  assert.equal(tools.changes.length, 1);
  await tools.update({ id: 'task', name: 'Retry me' });
  assert.equal((await m.store.get('task')).prompt, 'Accepted');
  assert.equal((await m.store.get('task')).name, 'Retry me');
});

test('strict target reads report access failures but tolerate unrelated corrupt task files', async (t) => {
  const m = setup(t);
  await m.store.save({ ...base, id: 'task', name: 'Before' });
  const unrelated = path.join(m.root, 'codex', 'broken');
  fs.mkdirSync(unrelated);
  fs.writeFileSync(path.join(unrelated, 'automation.toml'), 'broken = [');
  assert.equal((await m.store.update('task', { name: 'After' })).name, 'After');
  const read = fs.promises.readFile;
  const file = path.join(m.root, 'codex', 'task', 'automation.toml');
  const access = Object.assign(new Error('task access denied'), { code: 'EACCES' });
  const mocked = t.mock.method(fs.promises, 'readFile', (name: any, ...args: any[]) => {
    if (name === file) return Promise.reject(access);
    return (read as any)(name, ...args);
  });
  await assert.rejects(m.store.update('task', { name: 'Lost' }), /task access denied/);
  mocked.mock.restore();
  const readdir = fs.promises.readdir;
  t.mock.method(fs.promises, 'readdir', (dir: any, ...args: any[]) => {
    if (dir === m.store.o.codexDir()) return Promise.reject(access);
    return (readdir as any)(dir, ...args);
  });
  await assert.rejects(m.store.update('task', { name: 'Lost' }), /task access denied/);
});

for (const reverse of [false, true]) {
  test(`independent patches combine and same-field patches follow admission order (reverse=${reverse})`, async (t) => {
    const m = setup(t);
    await m.store.save({ ...base, id: 'task', name: 'Old', prompt: 'Old' });
    const patches = [{ name: 'New name' }, { prompt: 'New prompt' }];
    if (reverse) patches.reverse();
    await Promise.all(patches.map((patch) => m.store.update('task', patch)));
    assert.equal((await m.store.get('task')).name, 'New name');
    assert.equal((await m.store.get('task')).prompt, 'New prompt');
    const names = reverse ? ['Second', 'First'] : ['First', 'Second'];
    await Promise.all(names.map((name) => m.store.update('task', { name })));
    assert.equal((await m.store.get('task')).name, names.at(-1));
  });

  test(`real heartbeat remembering and tool rename both survive (remember first=${reverse})`, async (t) => {
    const m = setup(t);
    const task = await m.store.save({ ...base, id: 'task', kind: 'heartbeat', name: 'Old' });
    const tools = toolsFor(m.store);
    const remember = () => m.store.rememberChat(task, 'remembered');
    const rename = () => tools.update({ id: 'task', name: 'Renamed' });
    const operations = reverse ? [remember, rename] : [rename, remember];
    await Promise.all(operations.map((operation) => operation()));
    const saved = await m.store.get('task');
    assert.equal(saved.target_thread_id, 'remembered');
    assert.equal(saved.name, 'Renamed');
  });
}

test('queued deletion retires an update; a completed update cannot resurrect a later deletion', async (t) => {
  const m = setup(t);
  const task = await m.store.save({ ...base, id: 'task', name: 'Before' });
  const tools = toolsFor(m.store);
  const deletion = m.store.remove(task.id);
  const update = tools.update({ id: task.id, name: 'After' });
  await assert.rejects(update, /No scheduled task/);
  await deletion;
  assert.equal(m.has('codex', task.id), false);
  assert.equal(tools.changes.length, 0);
  await m.store.save(task);
  await Promise.all([tools.update({ id: task.id, name: 'Accepted' }), m.store.remove(task.id)]);
  assert.equal(await m.store.get(task.id), null);
  assert.equal(tools.changes.length, 1);
});

test('an unreadable pending transfer destination cannot fall back to and overwrite the old source', async (t) => {
  const m = setup(t);
  await m.store.save({ ...base, id: 'task', name: 'Source' });
  const destination = path.join(m.root, 'mopilot', 'task');
  fs.mkdirSync(destination, { recursive: true });
  fs.writeFileSync(path.join(destination, 'automation.toml'), 'transfer_from = "codex"\nprompt = [');
  await assert.rejects(m.store.update('task', { name: 'Lost edit' }));
  assert.equal(m.read('codex', 'task').name, 'Source');
  assert.equal(fs.readFileSync(path.join(destination, 'automation.toml'), 'utf8'), 'transfer_from = "codex"\nprompt = [');
});
