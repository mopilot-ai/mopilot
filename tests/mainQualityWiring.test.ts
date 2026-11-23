import { test, mock, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { loadMain, unloadMain } from './support/electron-main-harness.ts';
mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
after(() => unloadMain());

test('browser Clear browsing data IPC clears live navigation history and reports storage failures', async () => {
  const h = await loadMain();
  await h.ready();
  const ses = h.partitions.get('persist:browser');
  const page = h.wc();
  page.session = ses;
  await h.invoke('browser:clearData');
  assert.equal(page.navigationHistory.clear.mock.callCount(), 1);
  ses.clearStorageData.mock.mockImplementation(async () => {
    throw new Error('storage unavailable');
  });
  await assert.rejects(h.invoke('browser:clearData'), /storage unavailable/);
});

test('Git IPC retains repository info and status through the extracted query service', async () => {
  const h = await loadMain();
  await h.ready();
  const repo = path.join(h.tmp, 'quality-repo');
  fs.mkdirSync(repo);
  fs.writeFileSync(path.join(repo, 'new.txt'), 'one\ntwo\n');
  const responses: Record<string, string> = {
    'rev-parse --show-toplevel': repo + '\n',
    'symbolic-ref --quiet --short HEAD': 'main\n',
    'config --get remote.origin.url': 'git@example.test:repo\n',
    'branch --format=%(refname:short)': 'main\n',
    'status --porcelain=v1 -uall -z': '?? new.txt\0',
    'diff HEAD --no-color --no-ext-diff --no-textconv --no-relative --src-prefix=a/ --dst-prefix=b/ --numstat -z': '',
    // an untracked file's lines are counted by Git against /dev/null
    'diff --no-index --no-color --no-ext-diff --no-textconv --no-relative --src-prefix=a/ --dst-prefix=b/ --numstat -z -- /dev/null new.txt':
      '2\t0\tnew.txt\0',
  };
  h.cp.exec = (_cmd: string, args: string[]) => ({ stdout: responses[args.join(' ')] });
  assert.deepEqual(await h.invoke('git:info', repo), { root: repo, branch: 'main', remote: 'git@example.test:repo', branches: ['main'] });
  assert.deepEqual(await h.invoke('git:status', repo), { files: [{ code: '??', path: 'new.txt', added: 2, removed: 0 }] });
});
