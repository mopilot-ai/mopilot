// Codex adapter workspace cases using the shared scripted app-server and session fixtures.
import { test, assert, setup, settle } from './fixture.ts';

export function registerWorkspace() {
  test('workspace baseline precedes turn execution and completion publishes the full diff under the owning chat', async () => {
    const calls: any[] = [];
    const changes = {
      async begin(id: string, cwd: string) {
        calls.push(['begin', id, cwd]);
      },
      async finish(id: string, turn: string) {
        calls.push(['finish', id, turn]);
        return 'two-file-patch';
      },
      abort() {},
      clear() {},
    };
    const { a, server, events } = setup(
      {
        'turn/start': () => {
          calls.push(['start']);
          return { turn: { id: 'turn-1' } };
        },
      },
      { segments: { chat: 'native' }, turnChanges: changes },
    );
    try {
      await a.startTurn('chat', { kind: 'codex', id: 'native' }, { id: 'q', text: 'fix', opts: {}, attachments: [] });
      assert.deepEqual(calls, [['begin', 'native', '/work'], ['start']]);
      server.notify('turn/completed', { threadId: 'native', turn: { id: 'turn-1', status: 'completed' } });
      await settle();
      const diff = events.find(({ e }) => e.method === 'turn/diff/updated')!.e;
      assert.equal(diff.chatId, 'chat');
      assert.deepEqual(diff.params, { threadId: 'chat', turnId: 'turn-1', diff: 'two-file-patch' });
      assert.deepEqual(calls.at(-1), ['finish', 'native', 'turn-1']);
    } finally {
      server.listeners.clear();
    }
  });

  test('failed starts abort workspace snapshots, exits clear them, and failed completion capture keeps native diffs', async () => {
    for (const result of [undefined, '', new Error('snapshot')]) {
      const calls: string[] = [];
      const { a, server, events } = setup(
        {
          'turn/start': () => {
            throw new Error('start');
          },
        },
        {
          turnChanges: {
            async begin() {},
            abort(id: string) {
              calls.push(id);
            },
            clear() {
              calls.push('clear');
            },
            async finish() {
              if (result instanceof Error) throw result;
              return result;
            },
          },
        },
      );
      try {
        await a.startTurn('thread', { kind: 'codex', id: 'thread' }, { id: 'q', text: 'fix', opts: {}, attachments: [] });
        assert.deepEqual(calls, ['thread']);
        server.notify('turn/completed', { threadId: 'thread', turn: { id: 'turn' } });
        await settle();
        const diffs = events.filter(({ e }) => e.method === 'turn/diff/updated');
        assert.equal(diffs.length, result === '' ? 1 : 0);
        server.notify('turn/completed', { threadId: 'thread', turn: {} });
        await settle();
        server.emit({ kind: 'stopped' });
        assert.equal(calls.at(-1), 'clear');
      } finally {
        server.listeners.clear();
      }
    }
  });

  test('completion reaches the queue controller only after capturing the ending turn, including capture failure', async () => {
    for (const rejects of [false, true]) {
      let resolve!: (value: string) => void;
      let reject!: (error: Error) => void;
      const { server, observed, events } = setup(
        {},
        {
          turnChanges: {
            finish: () =>
              new Promise((r, j) => {
                resolve = r;
                reject = j;
              }),
          },
        },
      );
      try {
        server.notify('turn/completed', { threadId: 'native', turn: { id: 'turn' } });
        assert.equal(observed.filter((m) => m.method === 'turn/completed').length, 0);
        if (rejects) reject(new Error('capture'));
        else resolve('full diff');
        await settle();
        assert.equal(observed.filter((m) => m.method === 'turn/completed').length, 1);
        assert.equal(events.filter(({ e }) => e.method === 'turn/diff/updated').length, rejects ? 0 : 1);
      } finally {
        server.listeners.clear();
      }
    }
  });

  test('thread reads and paged turn reads restore captured diffs while leaving empty responses unchanged', async () => {
    const restored: string[] = [];
    const { a } = setup(
      {
        'thread/read': () => ({ thread: { turns: [{ id: 'turn' }] } }),
        'thread/turns/list': () => ({ data: [{ id: 'turn' }], nextCursor: 'next' }),
      },
      {
        turnChanges: {
          restore(id: string, turns: any[]) {
            restored.push(id);
            return turns.map((t) => ({ ...t, diff: 'full' }));
          },
        },
      },
    );
    try {
      assert.equal((await a.threadRead('native')).thread.turns[0].diff, 'full');
      assert.equal((await a.threadTurns('native')).data[0].diff, 'full');
      assert.deepEqual(restored, ['native', 'native']);
    } finally {
      a.server.listeners.clear();
    }
    const empty = setup(
      {},
      {
        turnChanges: {
          restore() {
            throw new Error('must not restore absent arrays');
          },
        },
      },
    );
    try {
      assert.deepEqual(await empty.a.threadRead('native'), {});
      assert.deepEqual(await empty.a.threadTurns('native'), {});
    } finally {
      empty.server.listeners.clear();
    }
  });
}
