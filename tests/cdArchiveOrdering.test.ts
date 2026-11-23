// Family archive rechecks the main parent and current descendants after git/PR reads and child-stop boundaries.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { orchestration } from './support/orchestration-harness.ts';
import { deferred } from './support/async-scenarios.ts';

const require = createRequire(import.meta.url);
const { archiveFamily, detach } = require('../electron/session/orchestration/lifecycle.cjs');
const ok = (stdout = '') => ({ ok: true, stdout, stderr: '' });
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
const canceled = (error: any) => error.code === 'archive_cancelled';

function fixture(worktree = false) {
  const h = orchestration({
    run: {
      git: async (args: string[]) => ok(args[0] === 'status' ? '' : 'worker'),
      gh: async () => ok('[]'),
    },
  });
  h.records.set('a', { meta: {} });
  h.records.set('b', { meta: {} });
  h.journal.change((d: any) => {
    for (const id of ['a', 'b'])
      d.children[id] = {
        parentId: 'top',
        name: id,
        title: id,
        cwd: `/repo/${id}`,
        useWorktree: worktree,
        createdAt: 1,
        driven: [],
        lastReport: null,
      };
  });
  return h;
}

test('parent deletion, archive and native switch during facts do not archive any child', async () => {
  for (const invalidate of [
    (h: ReturnType<typeof fixture>) => h.records.delete('top'),
    (h: ReturnType<typeof fixture>) => {
      h.records.get('top').meta.archived = 1;
    },
    (h: ReturnType<typeof fixture>) => h.refs.set('top', { kind: 'claude', id: 'new', key: 'new' }),
  ]) {
    const h = fixture(true);
    const pending = deferred<any>();
    h.orch.o.run.git = async (args: string[]) => (args[0] === 'status' ? pending.promise : ok('worker'));
    const result = archiveFamily(h.orch, 'top');
    await tick();
    invalidate(h);
    pending.resolve(ok());
    await assert.rejects(result, canceled);
    assert.equal(
      h.log.some((item) => item[0] === 'archive'),
      false,
    );
  }
});

test('a child detached or removed during facts is preserved, with no stale automatic archive', async () => {
  for (const invalidate of [
    (h: ReturnType<typeof fixture>) => detach(h.orch, 'a'),
    (h: ReturnType<typeof fixture>) => h.records.delete('a'),
  ]) {
    const h = fixture(true);
    const pending = deferred<any>();
    h.orch.o.run.gh = async () => pending.promise;
    const result = archiveFamily(h.orch, 'top');
    await tick();
    invalidate(h);
    pending.resolve(ok('[]'));
    const outcome = await result;
    assert.equal(outcome.needsChoice, true, 'retired facts are unknown rather than clean evidence');
    assert.equal(
      h.log.some((item) => item[0] === 'archive'),
      false,
    );
  }
});

test('parent-only preserves every child and avoids external reads; all preserves new descendants outside its snapshot', async () => {
  const parent = fixture(true);
  parent.orch.o.run.git = async () => {
    throw new Error('Parent only must not read git');
  };
  const kept = await archiveFamily(parent.orch, 'top', 'parent');
  assert.deepEqual(kept.archived, ['top']);
  assert.deepEqual(kept.remaining, ['a', 'b']);
  const all = fixture();
  all.states.set('a', { turn: 'running' });
  all.controller.stopChat = async () => {
    all.records.set('new', { meta: {} });
    all.journal.change(
      (d: any) => (d.children.new = { parentId: 'top', name: 'new', title: 'new', createdAt: 2, driven: [], lastReport: null }),
    );
    return true;
  };
  const result = await archiveFamily(all.orch, 'top', 'all');
  assert.deepEqual(result.remaining, ['new']);
  assert.equal(all.journal.child('new').detached, true);
});

test('parent retirement during a child stop cannot archive that child after the awaited stop', async () => {
  const h = fixture();
  h.states.set('a', { turn: 'running' });
  h.controller.stopChat = async () => {
    h.records.get('top').meta.archived = 1;
    return true;
  };
  await assert.rejects(archiveFamily(h.orch, 'top', 'all'), canceled);
  assert.equal(
    h.log.some((item) => item[0] === 'archive'),
    false,
  );
});

test('detaching a child while Stop waits keeps it from the original whole-family archive', async () => {
  const h = fixture();
  h.states.set('a', { turn: 'running' });
  h.controller.stopChat = async () => {
    detach(h.orch, 'a');
    return true;
  };
  const result = await archiveFamily(h.orch, 'top', 'all');
  assert.ok(!result.archived.includes('a'));
  assert.equal(h.records.get('a').meta.archived, undefined);
});

test('late activity observed between sibling archives keeps that sibling and detaches it', async () => {
  const h = fixture();
  const archive = h.orch.o.archive;
  h.orch.o.archive = (id: string) => {
    const result = archive(id);
    if (id === 'a') h.states.set('b', { turn: 'running' });
    return result;
  };
  const result = await archiveFamily(h.orch, 'top');
  assert.deepEqual(result.archived, ['a', 'top']);
  assert.deepEqual(result.remaining, ['b']);
  assert.equal(h.journal.child('b').detached, true);
});

test('an independently archived sibling is skipped and replacement owner stops the remainder', async () => {
  const skipped = fixture();
  const archive = skipped.orch.o.archive;
  skipped.orch.o.archive = (id: string) => {
    const result = archive(id);
    if (id === 'a') skipped.records.get('b').meta.archived = 2;
    return result;
  };
  assert.deepEqual((await archiveFamily(skipped.orch, 'top', 'all')).archived, ['a', 'top']);
  const retired = fixture();
  const write = retired.orch.o.archive;
  retired.orch.o.archive = (id: string) => {
    const result = write(id);
    if (id === 'a') retired.refs.set('top', { kind: 'claude', id: 'new', key: 'new' });
    return result;
  };
  await assert.rejects(archiveFamily(retired.orch, 'top', 'all'), canceled);
  assert.deepEqual(
    retired.log.filter((item) => item[0] === 'archive').map((item) => item[1]),
    ['a'],
  );
});

test('pending duplicates coalesce while distinct user decisions serialize behind facts', async () => {
  const h = fixture(true);
  h.records.get('a').meta.pinned = true;
  const pending = deferred<any>();
  let reads = 0;
  h.orch.o.run.gh = async () => {
    reads++;
    return pending.promise;
  };
  const read = archiveFamily(h.orch, 'top');
  const duplicate = archiveFamily(h.orch, 'top');
  const explicit = archiveFamily(h.orch, 'top', 'all');
  await tick();
  assert.equal(reads, 2, 'one query per worktree, not per duplicate click');
  assert.equal(
    h.log.some((item) => item[0] === 'archive'),
    false,
  );
  assert.equal(h.orch.archiving.has('top'), true);
  pending.resolve(ok('[]'));
  const [first, second] = await Promise.all([read, duplicate]);
  assert.equal(first.needsChoice, true);
  assert.deepEqual(second, first);
  assert.deepEqual((await explicit).archived, ['a', 'b', 'top']);
  assert.equal(h.orch.archiving.has('top'), false);
});

test('benign metadata writes during facts do not retire a stable chat, while queued old scope cannot follow a replacement', async () => {
  const benign = fixture(true);
  const metadata = deferred<any>();
  benign.orch.o.run.gh = async () => metadata.promise;
  const result = archiveFamily(benign.orch, 'top');
  await tick();
  benign.records.set('top', { meta: { title: 'New title' } });
  benign.records.set('a', { meta: { title: 'Renamed worker' } });
  metadata.resolve(ok('[]'));
  assert.deepEqual((await result).archived, ['a', 'b', 'top']);
  const h = fixture(true);
  const pending = deferred<any>();
  h.orch.o.run.gh = async () => pending.promise;
  const old = archiveFamily(h.orch, 'top');
  const queued = archiveFamily(h.orch, 'top', 'all');
  await tick();
  h.refs.set('top', { key: 'replacement', kind: 'claude', id: 'new' });
  pending.resolve(ok('[]'));
  await assert.rejects(old, canceled);
  await assert.rejects(queued, canceled);
  assert.equal(h.orch.archiving.has('top'), false);
  assert.deepEqual((await archiveFamily(h.orch, 'top', 'all')).archived, ['a', 'b', 'top']);
});

test('Archive all uses the displayed id set, retaining unseen workers and their nested family', async () => {
  const h = fixture();
  h.records.set('grand', { meta: {} });
  h.journal.change(
    (d: any) => (d.children.grand = { parentId: 'b', name: 'grand', title: 'grand', createdAt: 3, driven: [], lastReport: null }),
  );
  const result = await archiveFamily(h.orch, 'top', 'all', ['a', 'a', 'not-a-family-member']);
  assert.deepEqual(result.archived, ['a', 'top']);
  assert.deepEqual(result.remaining, ['b', 'grand']);
  assert.equal(h.journal.child('b').detached, true);
  assert.equal(h.journal.child('grand').detached, undefined);
  const empty = fixture();
  assert.deepEqual((await archiveFamily(empty.orch, 'top', 'all', [])).archived, ['top']);
  for (const scope of [null, 'a', [1], ['']]) {
    const invalid = fixture();
    await assert.rejects(archiveFamily(invalid.orch, 'top', 'all', scope), (error: any) => error.code === 'invalid_archive_scope');
    assert.equal(
      invalid.log.some((item) => item[0] === 'archive'),
      false,
    );
  }
});

test('child metadata may settle with its own Stop, but replacement native sessions and new running turns are retained', async () => {
  for (const replacement of ['metadata', 'native', 'turn']) {
    const h = fixture();
    h.states.set('a', { turn: 'running' });
    h.controller.stopChat = async () => {
      h.records.set('a', { meta: { title: 'Worker completed' } });
      if (replacement === 'native') h.refs.set('a', { kind: 'claude', id: 'new', key: 'new' });
      if (replacement === 'turn') {
        h.rts.set('a', { inputToken: 'new-human-message' });
        h.states.set('a', { turn: 'running' });
      } else {
        h.rts.set('a', { inputToken: null });
        h.states.set('a', { turn: 'idle' });
      }
      return true;
    };
    const result = await archiveFamily(h.orch, 'top', 'all');
    assert.equal(result.archived.includes('a'), replacement === 'metadata', replacement);
    assert.equal(h.journal.child('a').detached, replacement === 'metadata' ? undefined : true);
  }
});

test('the parent Stop can clear its own token, while a replacement running parent remains available', async () => {
  for (const newHumanTurn of [false, true]) {
    const h = fixture();
    h.states.set('top', { turn: 'running' });
    h.controller.stopChat = async () => {
      h.rts.set('top', { inputToken: newHumanTurn ? 'replacement-human-input' : null });
      h.states.set('top', { turn: newHumanTurn ? 'running' : 'idle' });
      return true;
    };
    const request = archiveFamily(h.orch, 'top', 'parent');
    if (newHumanTurn) {
      await assert.rejects(request, canceled);
      assert.equal(h.records.get('top').meta.archived, undefined);
    } else assert.deepEqual((await request).archived, ['top']);
  }
});

test('a sibling replaced or deleted before its archive is kept outside the old operation', async () => {
  for (const replacement of ['native', 'delete']) {
    const h = fixture();
    const archive = h.orch.o.archive;
    h.orch.o.archive = (id: string) => {
      const result = archive(id);
      if (id === 'a') {
        if (replacement === 'native') h.refs.set('b', { kind: 'claude', id: 'new', key: 'new' });
        else h.records.delete('b');
      }
      return result;
    };
    assert.deepEqual((await archiveFamily(h.orch, 'top', 'all')).archived, ['a', 'top']);
  }
});

test('a refused Stop retains a working chat and releases the archive hold; an already idle chat can archive', async () => {
  for (const idle of [false, true]) {
    const h = fixture();
    h.states.set('a', { turn: 'running' });
    h.controller.stopChat = async () => {
      if (idle) h.states.set('a', { turn: 'idle' });
      return false;
    };
    const request = archiveFamily(h.orch, 'top', 'all');
    if (idle) assert.deepEqual((await request).archived, ['a', 'b', 'top']);
    else {
      await assert.rejects(request, (error: any) => error.code === 'stop_failed');
      assert.equal(
        h.log.some((item) => item[0] === 'archive'),
        false,
      );
    }
    assert.equal(h.orch.archiving.has('top'), false);
  }
});

test('retained deletion receipts block immediate requests and retire pending reads even though metadata stays', async () => {
  const immediate = fixture();
  immediate.deleted.add('top');
  await assert.rejects(archiveFamily(immediate.orch, 'top'), (error: any) => error.code === 'not_found');
  const h = fixture(true);
  const pending = deferred<any>();
  h.orch.o.run.gh = async () => pending.promise;
  const result = archiveFamily(h.orch, 'top');
  await tick();
  h.deleted.add('top');
  pending.resolve(ok('[]'));
  await assert.rejects(result, canceled);
  assert.equal(
    h.log.some((item) => item[0] === 'archive'),
    false,
  );
  const child = fixture();
  child.deleted.add('a');
  assert.deepEqual((await archiveFamily(child.orch, 'top', 'all')).archived, ['b', 'top']);
});

test('archiving an already archived parent is idempotent and notes remain until its last retained reference retires', async () => {
  const h = fixture();
  const removed: string[] = [];
  h.orch.o.cleanupNotes = async (root: string, current: () => boolean) => {
    assert.equal(current(), true);
    removed.push(root);
    return true;
  };
  h.journal.change((d: any) => {
    d.children.a.notesRoot = 'top';
    d.children.b.notesRoot = 'top';
  });
  await archiveFamily(h.orch, 'top', 'parent');
  assert.equal(removed.includes('top'), false, 'detached children keep their original notes directory');
  const already = await archiveFamily(h.orch, 'top', 'all');
  assert.equal(already.already, true);
  assert.deepEqual(already.archived, []);
  await archiveFamily(h.orch, 'a');
  assert.equal(removed.includes('top'), false, 'one live reference remains');
  await archiveFamily(h.orch, 'b');
  assert.equal(removed.includes('top'), true);
  assert.equal(h.orch.archiving.size, 0);
});

test('a restoration while notes cleanup waits prevents deletion of the shared directory', async () => {
  const h = fixture();
  h.journal.change((d: any) => {
    d.children.a.notesRoot = 'top';
    d.children.b.notesRoot = 'top';
  });
  const pending = deferred<void>();
  const results: boolean[] = [];
  h.orch.o.cleanupNotes = async (_root: string, current: () => boolean) => {
    await pending.promise;
    results.push(current());
    return current();
  };
  const request = archiveFamily(h.orch, 'top', 'all');
  await tick();
  h.records.get('a').meta.archived = null;
  pending.resolve();
  await request;
  assert.deepEqual(results, [false]);
});

test('newly queued user input wins over a pending Stop while the preexisting queue belongs to the explicit choice', async () => {
  for (const newMessage of [false, true]) {
    const h = fixture();
    h.states.set('top', { turn: 'running', queue: [{ id: 'before' }] });
    h.controller.stopChat = async () => {
      h.states.set('top', { turn: 'idle', queue: [{ id: 'before' }, ...(newMessage ? [{ id: 'new-user-message' }] : [])] });
      return true;
    };
    const result = archiveFamily(h.orch, 'top', 'parent');
    if (newMessage) {
      await assert.rejects(result, canceled);
      assert.equal(h.records.get('top').meta.archived, undefined);
    } else assert.deepEqual((await result).archived, ['top']);
  }
});

test('a fresh archive invocation after restore does not coalesce with an old generation awaiting facts', async () => {
  const h = fixture(true);
  let generation = 0;
  h.orch.o.chats.archiveEpoch = () => generation;
  const pending = deferred<any>();
  h.orch.o.run.gh = async () => pending.promise;
  const stale = archiveFamily(h.orch, 'top');
  await tick();
  generation += 2; // A completed archive and restore both change the main store's generation.
  const fresh = archiveFamily(h.orch, 'top');
  const rejected = assert.rejects(stale, canceled);
  pending.resolve(ok('[]'));
  await rejected;
  assert.deepEqual((await fresh).archived, ['a', 'b', 'top']);
  assert.equal(h.orch.archiving.has('top'), false);
});

test('a grandchild created while its parent is stopping detaches if that parent archives; live survivor subtrees stay intact', async () => {
  for (const retainParent of [false, true]) {
    const h = fixture();
    h.states.set('a', { turn: 'running' });
    h.controller.stopChat = async () => {
      h.records.set('new', { meta: {} });
      h.journal.change(
        (d: any) => (d.children.new = { parentId: 'a', name: 'new', title: 'new', createdAt: 2, driven: [], lastReport: null }),
      );
      if (retainParent) detach(h.orch, 'a');
      return true;
    };
    const result = await archiveFamily(h.orch, 'top', 'all', ['a', 'b']);
    assert.equal(h.records.get('new').meta.archived, undefined);
    assert.equal(!!h.journal.child('new').detached, !retainParent);
    assert.equal(h.journal.child('new').parentId, 'a');
    assert.equal(h.records.get('a').meta.archived !== undefined, !retainParent);
    if (!retainParent) assert.deepEqual(result.remaining, ['new']);
  }
});
