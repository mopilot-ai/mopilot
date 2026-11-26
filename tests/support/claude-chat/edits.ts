// Claude renderer chat unit cases for edits.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { called, fx, claude, claudeThreadId, baseNative, UUID } from './fixture.ts';

export function registerEdits() {
  test('edit and resend: rewinds files after asking, then drops the message and what followed', async () => {
    const chat = claudeThreadId('edit-1');
    fx.state.threads[chat] = { cwd: '/w' };
    const tid = `h-${UUID}`;
    fx.state.runtime[chat] = { turns: [{ id: 'h-first' }, { id: tid }, { id: 'later' }] };
    assert.equal(await claude.claudeEditMessage(chat, 'pending-1'), false);
    const asked: string[] = [];
    let answer = false;
    (globalThis as any).confirm = (q: string) => (asked.push(q), answer);
    const rewinds: any[] = [];
    let dry: any = { canRewind: true, filesChanged: ['/w/src/a.ts'] };
    let real: any = { canRewind: true };
    baseNative({
      rewind: async (nid: string, opts: any, uuid: string, dryRun: boolean) => (
        rewinds.push([nid, opts.cwd, uuid, dryRun]), dryRun ? dry : real
      ),
    });
    assert.equal(await claude.claudeEditMessage(chat, tid), false);
    assert.deepEqual(called('touchChat'), []);
    assert.match(asked[0], /a\.ts/);
    answer = true;
    assert.equal(await claude.claudeEditMessage(chat, tid), true);
    assert.deepEqual(
      fx.state.runtime[chat].turns.map((t: any) => t.id),
      ['h-first'],
    );
    assert.deepEqual(rewinds.at(-1), [chat, '/w', UUID, false]);
    // a turn that's gone leaves the list alone; no files: no question
    dry = { canRewind: true };
    asked.length = 0;
    fx.state.threads[chat] = {};
    assert.equal(await claude.claudeEditMessage(chat, tid), true);
    assert.deepEqual(asked, []);
    assert.equal(rewinds.at(-1)[1], '/home/me');
    assert.deepEqual(
      fx.state.runtime[chat].turns.map((t: any) => t.id),
      ['h-first'],
    );
    // refusals and errors
    dry = { canRewind: false, error: 'no checkpoint' };
    assert.equal(await claude.claudeEditMessage(chat, tid), false);
    dry = { canRewind: false };
    assert.equal(await claude.claudeEditMessage(chat, tid), false);
    dry = { canRewind: true };
    real = { canRewind: false, error: 'changed' };
    assert.equal(await claude.claudeEditMessage(chat, tid), false);
    real = { canRewind: false };
    assert.equal(await claude.claudeEditMessage(chat, tid), false);
    baseNative({
      rewind: async () => {
        throw new Error("Error invoking remote method 'claude:rewind': Error: locked");
      },
    });
    assert.equal(await claude.claudeEditMessage(chat, tid), false);
    baseNative({
      rewind: async () => {
        throw 'raw';
      },
    });
    assert.equal(await claude.claudeEditMessage(chat, tid), false);
    assert.deepEqual(
      called('toast').map((c) => c[0]),
      [
        'no checkpoint',
        "This message can't be rewound",
        'changed',
        "This message can't be rewound",
        "Couldn't edit: locked",
        "Couldn't edit: raw",
      ],
    );
  });

  test('a Claude rewind from a retired native segment leaves the current chat activity alone', async () => {
    const chat = claudeThreadId('rewind-retired');
    fx.state.threads[chat] = { cwd: '/w' };
    const turns = [{ id: `h-${UUID}` }];
    fx.state.runtime[chat] = { turns };
    baseNative({
      rewind: async (_id: string, _options: unknown, _uuid: string, dryRun: boolean) => {
        if (!dryRun)
          fx.state.segments[chat] = [
            { harness: 'claude', nativeId: chat },
            { harness: 'codex', nativeId: 'next' },
          ];
        return { canRewind: true };
      },
    });
    assert.equal(await claude.claudeEditMessage(chat, `h-${UUID}`), false);
    assert.deepEqual(called('touchChat'), []);
    assert.equal(fx.state.runtime[chat].turns, turns);
  });

  test('fork: the whole chat or up to a turn, named after its source', async () => {
    const chat = claudeThreadId('fork-1');
    fx.state.threads[chat] = { name: 'Plan', cwd: '/w', projectId: 'p' };
    const forks: any[] = [];
    baseNative({ fork: async (sid: string, upTo: any) => (forks.push([sid, upTo]), { sessionId: `f${forks.length}` }) });
    assert.equal(await claude.claudeFork(chat), claudeThreadId('f1'));
    assert.equal(await claude.claudeFork(chat, `ct-${UUID}`), claudeThreadId('f2'));
    assert.equal(await claude.claudeFork(claudeThreadId('fork-none'), 'x'), claudeThreadId('f3'));
    assert.deepEqual(forks, [
      ['fork-1', null],
      ['fork-1', UUID],
      ['fork-none', null],
    ]);
    assert.deepEqual(
      called('upsertThread').map((c) => [c[0].name, c[0].projectId, c[0].cwd]),
      [
        ['Plan (fork)', 'p', '/w'],
        ['Plan (fork)', 'p', '/w'],
        [null, null, ''],
      ],
    );
    // a chat whose project lives only in its meta (no thread.projectId) forks into that project
    const kept = claudeThreadId('fork-kept');
    fx.state.threads[kept] = { name: 'Kept', cwd: '/elsewhere' };
    fx.state.chatProject[kept] = 'p9';
    baseNative({ fork: async () => ({ sessionId: 'f4' }) });
    const forked = await claude.claudeFork(kept);
    assert.equal(called('upsertThread').at(-1)![0].projectId, 'p9');
    assert.deepEqual(called('rememberChatProject').at(-1), [forked, 'p9']);
  });

  test('a fork starts on the account of the chat that owns the forked session, pinned when it was (R-3)', async () => {
    // a chat that switched from Codex: its Claude session is a later segment, its account is the chat's
    const native = claudeThreadId('fork-seg');
    fx.state.segments = {
      cx: [
        { harness: 'codex', nativeId: 'cx' },
        { harness: 'claude', nativeId: native },
      ],
    };
    fx.state.claudeChats = { cx: { id: 'work', pinned: true } };
    baseNative({ fork: async () => ({ sessionId: 'f5' }) });
    const forked = await claude.claudeFork(native);
    assert.deepEqual(fx.state.claudeChats[forked], { id: 'work', pinned: true });
  });

  test("an approval card's answer goes to main as the SDK's permission result", () => {
    const answers: any[] = [];
    baseNative({ permission: (id: string, out: any) => answers.push([id, out]) });
    claude.resolveClaudeRequest(
      {
        id: 7,
        method: 'item/commandExecution/requestApproval',
        params: { _claude: { input: { command: 'ls' }, suggestions: [{ rule: 'x' }] } },
      } as any,
      { decision: 'acceptForSession' },
    );
    claude.resolveClaudeRequest({ id: 8, method: 'item/commandExecution/requestApproval', params: {} } as any, { decision: 'accept' });
    assert.deepEqual(answers, [
      ['7', { behavior: 'allow', updatedInput: { command: 'ls' }, updatedPermissions: [{ rule: 'x' }] }],
      ['8', { behavior: 'allow', updatedInput: {} }],
    ]);
  });
}
