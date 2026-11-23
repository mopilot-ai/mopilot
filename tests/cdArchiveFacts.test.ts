// Family auto-archive uses fresh worktree/PR evidence and retires reads when the child identity, revision or lineage changes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { orchestration } from './support/orchestration-harness.ts';
import { deferred } from './support/async-scenarios.ts';

const require = createRequire(import.meta.url);
const { quietWorktree } = require('../electron/session/orchestration/archiveFacts.cjs');
const ok = (stdout = '') => ({ ok: true, stdout, stderr: '' });
const bad = () => ({ ok: false, stdout: '', stderr: 'unavailable' });
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

function fixture() {
  const calls: string[] = [];
  const h = orchestration({
    run: {
      git: async (args: string[]) => {
        calls.push(args[0]);
        return ok(args[0] === 'status' ? '' : 'worker');
      },
      gh: async () => {
        calls.push('gh');
        return ok('[]');
      },
    },
  });
  h.records.set('child', { meta: {} });
  h.states.set('child', { rev: 1 });
  h.journal.change(
    (d: any) =>
      (d.children.child = {
        parentId: 'top',
        name: 'child',
        title: 'Child',
        cwd: '/repo/worker',
        useWorktree: true,
        createdAt: 1,
        driven: [],
        lastReport: null,
      }),
  );
  return { ...h, calls };
}

test('only a clean worktree and an authoritative empty open-PR result establish quiet', async () => {
  const h = fixture();
  assert.equal(await quietWorktree(h.orch, 'child'), true);
  assert.deepEqual(h.calls, ['status', 'rev-parse', 'gh']);
  assert.equal(await quietWorktree(h.orch, 'not-linked'), true);
  h.journal.change((d: any) => (d.children.child.useWorktree = false));
  h.calls.length = 0;
  assert.equal(await quietWorktree(h.orch, 'child'), true);
  assert.deepEqual(h.calls, []);
});

test('external edits, unreadable git and malformed/detached branch names remain attention holds', async () => {
  const cases = [
    [bad(), ok('worker')],
    [ok(' M changed.ts\n'), ok('worker')],
    [ok(), bad()],
    [ok(), ok('')],
    [ok(), ok('HEAD\n')],
    [ok(), ok('--unexpected-option')],
    [ok(null as never), ok('worker')],
  ];
  for (const [status, branch] of cases) {
    const h = fixture();
    h.orch.o.run.git = async (args: string[]) => (args[0] === 'status' ? status : branch);
    assert.equal(await quietWorktree(h.orch, 'child'), false, JSON.stringify([status, branch]));
    assert.deepEqual(h.calls, [], 'no PR service is called when git evidence is insufficient');
  }
});

test('open PRs, unavailable services and malformed responses never count as a quiet child; successful retry works', async () => {
  for (const reply of [bad(), ok('[{"number":1}]'), ok('{}'), ok('{')]) {
    const h = fixture();
    h.orch.o.run.gh = async () => reply;
    assert.equal(await quietWorktree(h.orch, 'child'), false);
    h.orch.o.run.gh = async () => ok('[]');
    assert.equal(await quietWorktree(h.orch, 'child'), true);
  }
  for (const boundary of ['git', 'gh']) {
    const h = fixture();
    h.orch.o.run[boundary] = async () => {
      throw new Error('offline');
    };
    assert.equal(await quietWorktree(h.orch, 'child'), false);
  }
});

test('each child invalidator retires both the git stage and the later PR stage', async () => {
  const invalidators: Record<string, (h: ReturnType<typeof fixture>) => void> = {
    missing: (h) => {
      h.journal.change((d: any) => delete d.children.child);
    },
    folder: (h) => {
      h.journal.change((d: any) => (d.children.child.cwd = '/other'));
    },
    parent: (h) => {
      h.journal.change((d: any) => (d.children.child.parentId = 'other'));
    },
    detach: (h) => {
      h.journal.change((d: any) => (d.children.child.detached = true));
    },
    native: (h) => {
      h.refs.set('child', { key: 'replacement', kind: 'claude', id: 'new' });
    },
    deleted: (h) => {
      h.records.delete('child');
    },
    receipt: (h) => {
      h.deleted.add('child');
    },
    restored: (h) => {
      h.records.get('child').meta.activeAt = 2000;
    },
    revision: (h) => {
      h.states.set('child', { rev: 2 });
    },
    archived: (h) => {
      h.records.get('child').meta.archived = 1;
    },
  };
  for (const stage of ['git', 'gh']) {
    for (const [name, retire] of Object.entries(invalidators)) {
      const h = fixture();
      const pending = deferred<any>();
      if (stage === 'git') h.orch.o.run.git = async (args: string[]) => (args[0] === 'status' ? pending.promise : ok('worker'));
      else h.orch.o.run.gh = async () => pending.promise;
      const result = quietWorktree(h.orch, 'child');
      await tick();
      retire(h);
      pending.resolve(ok(stage === 'git' ? '' : '[]'));
      assert.equal(await result, false, `${stage}: ${name}`);
    }
  }
});

test('independent child reads combine in either completion order and unrelated journal edits do not retire them', async () => {
  for (const newerFirst of [false, true]) {
    const h = fixture();
    const first = deferred<any>();
    const second = deferred<any>();
    const replies = [first, second];
    h.orch.o.run.gh = () => replies.shift()!.promise;
    const a = quietWorktree(h.orch, 'child');
    const b = quietWorktree(h.orch, 'child');
    await tick();
    h.journal.change((d: any) => (d.wrapUps.other = { recap: 'An unrelated chat completed', actions: [] }));
    if (newerFirst) {
      second.resolve(ok('[]'));
      first.resolve(ok('[{"number":2}]'));
    } else {
      first.resolve(ok('[{"number":2}]'));
      second.resolve(ok('[]'));
    }
    assert.deepEqual(await Promise.all([a, b]), [false, true]);
  }
});
