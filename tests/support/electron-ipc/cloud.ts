// Electron IPC cloud unit cases with the shared fake main harness.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ready } from './fixture';

export function registerCloudCases() {
  test('Codex Cloud: environments from the ChatGPT backend, tasks through `codex cloud`', async () => {
    const h = await ready();
    const acc = h.one('Accounts');
    const fetch = h.electron.net.fetch;
    assert.deepEqual(await h.invoke('cloud:envs'), { error: 'Sign in with ChatGPT to use Codex Cloud' });
    acc.chatgptHeaders = async () => ({ authorization: 'x' });
    fetch.mock.mockImplementation(async () => ({ ok: false, status: 403 }));
    assert.deepEqual(await h.invoke('cloud:envs'), { error: "Couldn't load environments (403)" });
    const envs = [
      { id: 'e1', label: 'One', repo_map: { a: { repository_full_name: 'o/r' } }, is_pinned: true },
      { id: 'e2', name: 'Two', repo: 'o/two' },
      { id: 'e3', repo_map: {} },
    ];
    for (const data of [envs, { environments: envs }, { items: envs }]) {
      fetch.mock.mockImplementation(async () => ({ ok: true, json: async () => data }));
      assert.deepEqual(await h.invoke('cloud:envs'), {
        envs: [
          { id: 'e1', label: 'One', repo: 'o/r', repositories: ['o/r'], pinned: true },
          { id: 'e2', label: 'Two', repo: 'o/two', pinned: false },
          { id: 'e3', label: 'e3', repo: undefined, repositories: [], pinned: false },
        ],
      });
    }
    fetch.mock.mockImplementation(async () => ({ ok: true, json: async () => ({}) }));
    assert.deepEqual(await h.invoke('cloud:envs'), { envs: [] });
    fetch.mock.mockImplementation(async () => ({ ok: true, json: async () => [{ id: 'e4' }] }));
    assert.equal((await h.invoke('cloud:envs')).envs[0].repo, null);
    fetch.mock.mockImplementation(async () => {
      throw new Error('offline');
    });
    assert.deepEqual(await h.invoke('cloud:envs'), { error: 'offline' });
    fetch.mock.mockImplementation(async () => {
      throw 'raw';
    });
    assert.deepEqual(await h.invoke('cloud:envs'), { error: 'raw' });
    // tasks
    let out: any = { stdout: 'Created task_AB-1 ok\n' };
    h.cp.exec = () => out;
    assert.deepEqual(await h.invoke('cloud:exec', 'env1', 'do it'), { ok: true, id: 'task_AB-1', output: 'Created task_AB-1 ok' });
    assert.deepEqual(h.cp.execCalls.at(-1).args, ['cloud', 'exec', '--env', 'env1', '--attempts', '1', '--', 'do it']);
    // a prompt that looks like an option stays the prompt; "-" alone (stdin to the CLI) is refused without running it
    await h.invoke('cloud:exec', 'env1', '- add tests\n- ship');
    assert.deepEqual(h.cp.execCalls.at(-1).args.slice(-2), ['--', '- add tests\n- ship']);
    const runs = h.cp.execCalls.length;
    assert.deepEqual(await h.invoke('cloud:exec', 'env1', ' - '), {
      ok: false,
      id: null,
      output: 'Describe the task: "-" alone is not a prompt.',
    });
    assert.equal(h.cp.execCalls.length, runs);
    assert.equal(h.cp.execCalls.at(-1).opts.cwd, h.home);
    out = { err: { code: 2 }, stdout: '', stderr: 'failed\n' };
    assert.deepEqual(await h.invoke('cloud:exec', 'env1', 'p', 3), { ok: false, id: null, output: 'failed' });
    out = { stdout: '{"tasks":[1]}' };
    assert.deepEqual(await h.invoke('cloud:list', 'env1'), { tasks: [1] });
    assert.deepEqual(h.cp.execCalls.at(-1).args, ['cloud', 'list', '--json', '--limit', '20', '--env', 'env1']);
    out = { stdout: '', stderr: 'a\nnot signed in' };
    assert.deepEqual(await h.invoke('cloud:list'), { tasks: [], error: 'not signed in' });
    out = { stdout: 'oops' };
    assert.deepEqual(await h.invoke('cloud:list'), { tasks: [], error: 'oops' });
    out = { stdout: ' done ' };
    assert.deepEqual(await h.invoke('cloud:status', 't'), { ok: true, text: 'done' });
    out = { err: {}, stderr: ' bad ' };
    assert.deepEqual(await h.invoke('cloud:status', 't'), { ok: false, text: 'bad' });
    out = { stdout: 'diff' };
    assert.deepEqual(await h.invoke('cloud:diff', 't', 2), { ok: true, diff: 'diff', error: null });
    assert.deepEqual(h.cp.execCalls.at(-1).args, ['cloud', 'diff', 't', '--attempt', '2']);
    out = { err: { code: 1 }, stdout: 'partial', stderr: '' };
    assert.deepEqual(await h.invoke('cloud:diff', 't'), { ok: false, diff: 'partial', error: 'partial' });
    out = { err: { code: 1 }, stdout: '', stderr: 'no diff' };
    assert.equal((await h.invoke('cloud:diff', 't')).error, 'no diff');
    out = { stdout: 'applied' };
    assert.deepEqual(await h.invoke('cloud:apply', 't', '/w', 1), { ok: true, output: 'applied' });
    assert.equal(h.cp.execCalls.at(-1).opts.cwd, '/w');
    assert.deepEqual(h.cp.execCalls.at(-1).args, ['cloud', 'apply', 't', '--attempt', '1']);
    out = { stdout: '', stderr: 'conflict' };
    assert.deepEqual(await h.invoke('cloud:apply', 't'), { ok: true, output: 'conflict' });
    h.mod('platform/winbin.cjs').spawnArgs.mock.mockImplementation(() => {
      throw new Error('no codex');
    });
    assert.deepEqual(await h.invoke('cloud:status', 't'), { ok: false, text: 'no codex' });
    h.mod('platform/winbin.cjs').spawnArgs.mock.mockImplementation(() => {
      throw 'raw';
    });
    assert.deepEqual(await h.invoke('cloud:status', 't'), { ok: false, text: 'raw' });
  });

  test('a scoped launch verifies the current repository and account at main before executing', async () => {
    const h = await ready();
    const acc = h.one('Accounts');
    const fetch = h.electron.net.fetch;
    acc.chatgptHeaders = async () => ({ authorization: 'x' });
    let active: string | null = 'account-a';
    acc.view = () => ({ active });
    const claim = { repository: 'github.com/org/app', account: active };
    const result = (repo: string) => ({ ok: true, json: async () => [{ id: 'env', label: 'App', repo }] });
    fetch.mock.mockImplementation(async () => result('elsewhere/reconfigured'));
    const runs = h.cp.execCalls.length;
    active = 'account-other';
    assert.equal((await h.invoke('cloud:exec', 'env', 'Draft', 1, claim)).ok, false);
    assert.equal(h.cp.execCalls.length, runs);
    active = 'account-a';
    assert.equal((await h.invoke('cloud:exec', 'env', 'Draft', 1, claim)).ok, false);
    assert.equal(h.cp.execCalls.length, runs);
    fetch.mock.mockImplementation(async () => {
      active = 'account-b';
      return result('org/app');
    });
    assert.equal((await h.invoke('cloud:exec', 'env', 'Draft', 1, claim)).ok, false);
    assert.equal(h.cp.execCalls.length, runs);
    active = 'account-a';
    fetch.mock.mockImplementation(async () => result('org/app'));
    h.cp.exec = () => ({ stdout: 'created task_test' });
    assert.equal((await h.invoke('cloud:exec', 'env', 'Draft', 1, claim)).id, 'task_test');
    assert.deepEqual(h.cp.execCalls.at(-1).args, ['cloud', 'exec', '--env', 'env', '--attempts', '1', '--', 'Draft']);
    fetch.mock.mockImplementation(async () => ({ ok: true, json: async () => [{ id: 'env', repo_map: { missing: null } }] }));
    assert.deepEqual((await h.invoke('cloud:envs')).envs[0].repositories, [null]);
    active = null;
    acc.chatgptHeaders = async () => null;
    assert.equal((await h.invoke('cloud:exec', 'env', 'Draft', 1, { ...claim, account: null })).ok, false);
  });
}
