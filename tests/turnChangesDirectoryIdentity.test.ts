// Physical directory identities prevent mixed per-turn diff attribution.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtemp, mkdir, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const { TurnChanges } = createRequire(import.meta.url)('../electron/session/turnChanges.cjs');

// Existing in-memory snapshots use an in-memory directory identity too.
class VirtualTurnChanges extends TurnChanges {
  constructor(capture?: any, compare?: any, store?: any) {
    super(capture, compare, store, (cwd: string) => cwd);
  }
}

test('symlink aliases of one working folder retain native attribution', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'turn-alias-ut-'));
  try {
    const real = join(dir, 'real');
    const alias = join(dir, 'alias');
    await mkdir(real);
    await symlink(real, alias, 'junction');
    const saved: unknown[] = [];
    const changes = new TurnChanges(
      async () => 'tree',
      async () => 'mixed patch',
      { read: () => null, write: (_id: string, value: unknown) => saved.push(value) },
    );
    await changes.begin('first', real);
    await changes.begin('second', alias);
    assert.equal(await changes.finish('first', 'turn-1'), undefined);
    assert.equal(await changes.finish('second', 'turn-2'), undefined);
    assert.deepEqual(saved, []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('physical parent/child aliases overlap in either start order', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'turn-alias-parent-ut-'));
  try {
    const real = join(dir, 'real');
    const alias = join(dir, 'alias');
    await mkdir(join(real, 'src'), { recursive: true });
    await symlink(real, alias, 'junction');
    for (const folders of [
      [real, join(alias, 'src')],
      [join(alias, 'src'), real],
    ]) {
      const changes = new TurnChanges(
        async () => 'tree',
        async () => 'mixed patch',
      );
      await changes.begin('first', folders[0]);
      await changes.begin('second', folders[1]);
      assert.equal(await changes.finish('first'), undefined);
      assert.equal(await changes.finish('second'), undefined);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('retargeted aliases cannot publish a patch before capture, during capture or during comparison', async () => {
  for (const stage of ['before', 'capture', 'compare']) {
    const dir = await mkdtemp(join(tmpdir(), 'turn-retarget-ut-'));
    try {
      const first = join(dir, 'first');
      const second = join(dir, 'second');
      const alias = join(dir, 'alias');
      await mkdir(first);
      await mkdir(second);
      await symlink(first, alias, 'junction');
      const retarget = async () => {
        await rm(alias, { force: true });
        await symlink(second, alias, 'junction');
      };
      let captures = 0;
      const saved: unknown[] = [];
      const changes = new TurnChanges(
        async () => {
          if (++captures === 2 && stage === 'capture') await retarget();
          return 'tree';
        },
        async () => {
          if (stage === 'compare') await retarget();
          return 'mixed patch';
        },
        { read: () => null, write: (_id: string, value: unknown) => saved.push(value) },
      );
      await changes.begin('thread', alias);
      if (stage === 'before') await retarget();
      assert.equal(await changes.finish('thread', 'turn'), undefined, stage);
      assert.deepEqual(saved, []);
      assert.equal(changes.finishing.size, 0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
});

test('unknown physical scopes invalidate concurrent attribution, including finishing snapshots', async () => {
  for (const finishing of [false, true]) {
    let finish!: (value: string) => void;
    let captures = 0;
    const changes = new TurnChanges(
      async () => {
        if (++captures === 2 && finishing)
          return new Promise<string>((resolve) => {
            finish = resolve;
          });
        return 'tree';
      },
      async () => 'unproven patch',
      null,
      (cwd: string) => {
        if (cwd === '/unreadable') throw new Error('cannot resolve directory');
        return cwd;
      },
    );
    await changes.begin('first', '/first');
    const pending = finishing ? changes.finish('first') : null;
    await changes.begin('unknown', '/unreadable');
    assert.equal(await changes.finish('unknown'), undefined);
    if (finishing) finish('after');
    assert.equal(pending ? await pending : await changes.finish('first'), undefined);
    assert.equal(changes.baselines.size, 0);
    assert.equal(changes.finishing.size, 0);
  }
  const changes = new VirtualTurnChanges(
    async () => 'tree',
    async () => 'patch',
  );
  await changes.begin('thread', '/first');
  changes.resolveScope = () => {
    throw new Error('directory became unreadable');
  };
  assert.equal(await changes.finish('thread'), undefined);
  assert.equal(changes.finishing.size, 0);
});

for (const failure of ['identity', 'capture', 'missing']) {
  for (const retirement of ['finish', 'abort', 'clear']) {
    test(`a failed ${failure} before another turn reserves overlap until ${retirement}`, async () => {
      let failCapture = failure === 'capture';
      const changes = new TurnChanges(
        async (cwd: string) => {
          if (failCapture && cwd === '/failed') {
            failCapture = false;
            throw new Error('capture unavailable');
          }
          return 'tree';
        },
        async () => 'potentially mixed patch',
        null,
        (cwd: string) => {
          if (failure === 'identity' && cwd === '/failed') throw new Error('identity unavailable');
          return failure === 'capture' ? '/failed' : cwd;
        },
      );
      await changes.begin('failed', failure === 'missing' ? undefined : '/failed');
      await changes.begin('overlapping', '/other');
      assert.equal(await changes.finish('overlapping'), undefined);
      if (retirement === 'finish') assert.equal(await changes.finish('failed'), undefined);
      else if (retirement === 'abort') changes.abort('failed');
      else changes.clear();
      assert.equal(changes.baselines.size, 0);
      // Once the failed turn has retired, another turn can prove its own attribution.
      changes.capture = async () => 'tree';
      await changes.begin('later', '/other');
      assert.equal(await changes.finish('later'), 'potentially mixed patch');
    });
  }
}
