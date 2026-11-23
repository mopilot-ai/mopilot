// Computer-use grant cases registered by the original unit-test entrypoint.
import { test, assert, fs, os, path, GrantStore, ApprovalBroker, NOTES, MAIL, fakeChats, fakeController, rig } from './fixture.ts';

export function registerGrantCases() {
  test('grants: Allow in this chat goes in the chat meta, Always allow on the global list, Allow once nowhere', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cu-grants-'));
    const file = path.join(dir, 'capabilities', 'computer.json');
    const chats = fakeChats();
    const changed: (string | null)[] = [];
    const g = new GrantStore({ file, chats, onChange: (c: string | null) => changed.push(c), now: () => 5 });
    assert.equal(g.grant('c1', NOTES, 'click', 'once'), false);
    assert.deepEqual(g.forChat('c1'), []);
    g.grant('c1', NOTES, 'click', 'chat');
    assert.deepEqual(chats.meta.get('c1').computerGrants, [{ bundleId: 'com.apple.Notes', name: 'Notes', level: 'click', at: 5 }]);
    // a weaker grant later doesn't lower it
    g.grant('c1', NOTES, 'view', 'chat');
    assert.equal(g.chat('c1')[0].level, 'click');
    g.grant('c2', MAIL, 'full', 'always');
    assert.deepEqual(
      g.forChat('c1').map((x: any) => x.bundleId),
      ['com.apple.Notes', 'com.apple.mail'],
    );
    assert.deepEqual(
      g.forChat('c3').map((x: any) => x.bundleId),
      ['com.apple.mail'],
    );
    assert.deepEqual(changed, ['c1', 'c1', null]);
    // the global list and the deny list survive a restart
    g.setDeny(['com.example.bank', 'com.example.bank', ' ']);
    const again = new GrantStore({ file, chats });
    assert.deepEqual(
      again.global().map((x: any) => x.level),
      ['full'],
    );
    assert.deepEqual(again.deny(), ['com.example.bank']);
    assert.equal(again.revoke(null, 'com.apple.MAIL'), true);
    assert.equal(again.revoke('c1', 'com.apple.Notes'), true);
    assert.deepEqual(again.forChat('c1'), []);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('approval cards: shown in the chat, the first answer wins, a card that went away resolves null', async () => {
    const ctl = fakeController();
    const b = new ApprovalBroker({ controller: ctl });
    const p = b.ask('c1', 'computerAccess', { app: NOTES });
    const [card] = ctl.approvals.get('c1')!;
    assert.equal(card.method, 'sage/computerAccess');
    assert.equal(card.params.kind, 'computerAccess');
    assert.equal(b.answer(card.id, { decision: 'allow', scope: 'once' }), true);
    assert.equal(b.answer(card.id, { decision: 'deny' }), false);
    assert.deepEqual(await p, { decision: 'allow', scope: 'once' });
    assert.deepEqual(ctl.approvals.get('c1'), []);

    const q = b.ask('c1', 'computerConfirm', { verb: 'send' });
    b.sweep('c2', []);
    b.sweep('c1', ctl.approvals.get('c1'));
    b.sweep('c1', []);
    assert.equal(await q, null);
    await assert.rejects(b.ask('c1', 'nope', {}));
  });
}

export function registerGrantWriteCases() {
  test('global computer permission writes fail without changing grants or reporting a change', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cu-grant-failure-'));
    const file = path.join(dir, 'computer.json');
    const changed: (string | null)[] = [];
    const g = new GrantStore({ file, chats: fakeChats(), onChange: (id: string | null) => changed.push(id) });
    try {
      g.grant('c1', NOTES, 'click', 'always');
      g.setDeny(['com.example.bank']);
      const original = g.global();
      fs.rmSync(file);
      fs.mkdirSync(file);
      for (const operation of [
        () => g.grant('c1', MAIL, 'full', 'always'),
        () => g.revoke(null, NOTES.bundleId),
        () => g.setDeny([]),
        () => g.clearGlobal(),
      ]) {
        assert.throws(operation, { code: 'save_failed' });
        assert.deepEqual(g.global(), original);
        assert.deepEqual(g.deny(), ['com.example.bank']);
        assert.deepEqual(changed, [null, null]);
      }
      assert.equal(g.revoke(null, 'missing'), false);
      fs.rmSync(file, { recursive: true });
      assert.equal(g.grant('c1', MAIL, 'full', 'always'), true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  for (const harness of ['codex', 'claude', 'acp:gemini']) {
    test(`${harness}: a failed chat permission save refuses the action with a storage error`, async () => {
      const r = rig({ harness });
      try {
        r.grants.chats.patchMeta = () => false;
        const pending = r.reg.invoke('c1', 'c1', 'computer_click', { x: 20, y: 10 });
        await r.answerNext({ decision: 'allow', scope: 'chat', level: 'click' });
        const result = await pending;
        assert.equal(result.ok, false);
        assert.equal(result.error.code, 'save_failed');
        assert.equal(
          r.helper.calls.some((call) => call.method === 'click'),
          false,
        );
      } finally {
        r.done();
      }
    });
  }
}
