// A chat started on, moved to or moved back from one of the user's machines on a phone (electron/remote/methods/host.cjs, start.cjs): chat.move with or without the changes, back to this Mac by a project's id, a phone removed mid-read, chat.start on Claude Code, Codex and an ACP agent, and the Mac's refusal codes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rig } from './support/remote-kit.ts';
import { ok, fail, refusal, fakeHost } from './support/remoteHostKit.ts';

test('chat.move: Switch host from a phone with or without the changes; a chat gone, a removed phone and the Mac’s refusal codes', async () => {
  const { host, calls } = fakeHost();
  const r = rig({ host: () => host });
  const p = r.phone('p1');
  assert.deepEqual(ok(await p.ask('chat.move', { chatId: 'c1', hostId: 'ssh:box', folder: '/srv/a', carry: 'code' })), { chatId: 'c1' });
  // back to this Mac goes to the facade, which takes only a saved project's folder (app/hostPhone.cjs)
  ok(await p.ask('chat.move', { chatId: 'c2', hostId: 'local', folder: '/Users/me/proj', carry: 'none' }));
  assert.deepEqual(calls, [
    ['move', { chatId: 'c1', hostId: 'ssh:box', folder: '/srv/a', carry: 'code' }],
    ['move', { chatId: 'c2', hostId: 'local', folder: '/Users/me/proj', carry: 'none' }],
  ]);
  fail(await p.ask('chat.move', { chatId: 'nope', hostId: 'ssh:box', folder: '/srv', carry: 'none' }), 'gone');
  fail(await p.ask('chat.move', { chatId: 'c1', hostId: 'ssh:box', folder: '/srv' }), 'invalid', /changes/);
  fail(await p.ask('chat.move', { chatId: 'c1', hostId: 'ssh:box', carry: 'none' }), 'invalid', /folder/);
  for (const code of ['harness_not_configured', 'directory_missing', 'target_offline', 'turn_running']) {
    host.move = async () => {
      throw refusal(`Refused: ${code}`, code);
    };
    fail(await p.ask('chat.move', { chatId: 'c1', hostId: 'ssh:box', folder: '/srv', carry: 'none' }), code, /Refused/);
  }
  // a removed phone moves nothing
  let moved = 0;
  host.move = async () => void moved++;
  const client = r.service.phones.get('p1').client;
  r.link.removePair?.('p1');
  r.service.phones.delete('p1');
  await assert.rejects(
    r.service.call(client, 'chat.move', { chatId: 'c1', hostId: 'ssh:box', folder: '/srv', carry: 'none' }),
    /no longer paired/,
  );
  assert.equal(moved, 0);
});

test('chat.move back to this Mac names a saved project by id (no folder needed); a machine still takes a folder; the capability says so', async () => {
  const { host, calls } = fakeHost();
  const r = rig({ host: () => host });
  const p = r.phone('p1');
  assert.equal(ok(await p.ask('machine.hello')).capabilities.moveToProject, true);
  ok(await p.ask('chat.move', { chatId: 'c2', hostId: 'local', projectId: 'dev-repo', carry: 'none' }));
  assert.deepEqual(calls.at(-1), ['move', { chatId: 'c2', hostId: 'local', projectId: 'dev-repo', carry: 'none' }]);
  // a project id is only for this Mac; a machine needs its folder
  fail(await p.ask('chat.move', { chatId: 'c2', hostId: 'ssh:box', projectId: 'dev-repo', carry: 'none' }), 'invalid', /folder/);
  fail(await p.ask('chat.move', { chatId: 'c2', hostId: 'local', carry: 'none' }), 'invalid', /folder/);
  fail(await p.ask('chat.move', { chatId: 'c2', hostId: 'local', projectId: '../etc', carry: 'none' }), 'invalid', /project/);
  // the refusals main codes reach the phone
  host.move = async () => {
    throw refusal("That project isn't in MoPilot.", 'unknown_project');
  };
  fail(await p.ask('chat.move', { chatId: 'c2', hostId: 'local', projectId: 'gone', carry: 'none' }), 'unknown_project');
  // without Host there is no capability
  const none = rig().phone('p1');
  assert.equal(ok(await none.ask('machine.hello')).capabilities.moveToProject, false);
});

test('machine.hello says a phone may follow a machine’s chat itself only with Host, the phone’s own enrollment and host.phoneChat all on', async () => {
  const { host } = fakeHost();
  const state = { direct: true, chat: true };
  host.phoneDirect = { enabled: () => state.direct };
  host.phoneChat = { enabled: () => state.chat };
  const p = rig({ host: () => host }).phone('p1');
  assert.equal(ok(await p.ask('machine.hello')).capabilities.phoneChat, true);
  state.chat = false;
  assert.equal(ok(await p.ask('machine.hello')).capabilities.phoneChat, false, 'the flag is off');
  state.chat = true;
  state.direct = false;
  assert.equal(ok(await p.ask('machine.hello')).capabilities.phoneChat, false, 'no direct enrollment: no chat of its own');
  delete host.phoneChat;
  assert.equal(ok(await p.ask('machine.hello')).capabilities.phoneChat, false, 'a Host without the facade says no');
  assert.equal(ok(await rig().phone('p1').ask('machine.hello')).capabilities.phoneChat, false, 'without Host');
});

test('chat.move and chat.start: a phone removed while the machine’s folder or the plan was read moves and starts nothing', async () => {
  const { host } = fakeHost();
  let r = rig({ host: () => host });
  const p = r.phone('p1');
  let done = 0;
  // the facade reads the machine (an await), then checks the phone again before the effect
  const removeMeanwhile = async ({ check }: any) => {
    await Promise.resolve();
    r.service.phones.delete('p1');
    check();
    done++;
    return { chatId: 'x' };
  };
  host.move = removeMeanwhile;
  assert.equal(
    await p.ask('chat.move', { chatId: 'c1', hostId: 'ssh:box', folder: '/srv', carry: 'none' }),
    undefined,
    'a removed phone receives no reply',
  );
  r = rig({ host: () => host });
  host.start = removeMeanwhile;
  assert.equal(
    await r.phone('p1').ask('chat.start', { harness: 'claude', text: 'x', hostId: 'ssh:box', folder: '/srv' }),
    undefined,
    'a removed phone receives no reply',
  );
  assert.equal(done, 0);
});

test('chat.start on a machine carries the choice of where its model access comes from; a start that chose nothing sends none', async () => {
  const { host, calls } = fakeHost();
  const p = rig({ host: () => host }).phone('p1');
  const base = { harness: 'claude', text: 'go', projectId: 'p1', hostId: 'ssh:box', folder: '/srv/a' };
  ok(await p.ask('chat.start', { ...base, startId: 'start-0001', credential: { source: 'key' } }));
  ok(await p.ask('chat.start', { ...base, startId: 'start-0002' }));
  assert.deepEqual(calls[0][1].credential, { source: 'key' });
  assert.equal('credential' in calls[1][1], false);
});

const HARNESSES = ['claude', 'codex', 'acp:gemini'];
for (const harness of HARNESSES) {
  test(`chat.start on a machine with ${harness}: started there once per start id with the permission riding in the start; this Mac's start untouched`, async () => {
    const { host, calls } = fakeHost();
    const r = rig({ host: () => host });
    const p = r.phone('p1');
    const picks = {
      harness,
      text: 'build it',
      projectId: 'p1',
      hostId: 'ssh:box',
      folder: '/srv/a',
      model: 'm',
      effort: 'high',
      permission: 'default',
    };
    assert.deepEqual(ok(await p.ask('chat.start', { ...picks, startId: 'start-0001' })), { chatId: 'acp:host-claude:1' });
    assert.deepEqual(calls, [
      [
        'start',
        {
          attachments: [],
          hostId: 'ssh:box',
          folder: '/srv/a',
          harness,
          projectId: 'p1',
          text: 'build it',
          model: 'm',
          effort: 'high',
          permission: 'default',
          nativeMessageId: 'a79384a2-8761-5328-b075-ca64793a029f',
        },
      ],
    ]);
    // the panel's permission menu knows nothing of a machine's chat (#4193): it is never asked, so there is no warning
    assert.equal(r.calls.filter((c) => c[0] === 'permit').length, 0);
    assert.equal(r.calls.filter((c) => c[0] === 'start' || c[0] === 'usable').length, 0, "this Mac's start is not used");
    ok(await p.ask('chat.start', { ...picks, startId: 'start-0001' }));
    assert.equal(calls.length, 1, 'a retry is the same chat');
    ok(await r.phone('p2').ask('chat.start', { ...picks, startId: 'start-0001' }));
    const another = calls.at(-1)![1] as { nativeMessageId: unknown };
    assert.equal(typeof another.nativeMessageId, 'string');
    assert.notEqual(another.nativeMessageId, 'a79384a2-8761-5328-b075-ca64793a029f', 'another paired phone has a separate native identity');
    // 'local' is this Mac
    assert.deepEqual(ok(await p.ask('chat.start', { harness, text: 'here', hostId: 'local' })), { chatId: 'new-chat' });
  });
}

test('chat.start on a machine: the Mac’s refusal codes and words, a warning kept, what stays on this Mac refused', async () => {
  const { host } = fakeHost();
  const r = rig({ host: () => host });
  const p = r.phone('p1');
  const base = { harness: 'claude', text: 'hi', hostId: 'ssh:box', folder: '/srv' };
  for (const [code, message] of [
    ['harness_not_configured', 'Sign in to Claude Code on box.'],
    ['unknown_machine', 'That machine is not in the list.'],
    ['not_allowed', 'Host is not available for this account.'],
  ]) {
    host.start = async () => {
      throw refusal(message, code);
    };
    fail(await p.ask('chat.start', base), code, new RegExp(message.replace('.', '\\.')));
  }
  host.start = async () => ({ chatId: 'x', warning: "Your message didn't start: Host is off" });
  assert.deepEqual(ok(await p.ask('chat.start', base)), { chatId: 'x', warning: "Your message didn't start: Host is off" });
  // a permission on a machine chat never reaches the panel's menus, whatever they would say (#4193)
  r.ops.permit = async () => {
    throw new Error('That mode isn’t one this harness has.');
  };
  host.start = async () => ({ chatId: 'z' });
  assert.deepEqual(ok(await p.ask('chat.start', { ...base, permission: 'default' })), { chatId: 'z' });
  fail(await p.ask('chat.start', { ...base, attachments: ['0123456789abcdef'] }), 'forbidden', /Attach/);
  fail(await p.ask('chat.start', { ...base, skills: ['review'] }), 'invalid', /Skills/);
  fail(await p.ask('chat.start', { ...base, account: 'work' }), 'invalid', /account/);
  fail(await p.ask('chat.start', { ...base, worktree: true }), 'invalid', /worktree/);
  fail(await p.ask('chat.start', { harness: 'claude', text: 'hi', hostId: 'ssh:box' }), 'invalid', /folder/);
  fail(await p.ask('chat.start', { ...base, folder: '/srv/\0x' }), 'invalid', /folder/);
  fail(await p.ask('chat.start', { ...base, hostId: 7 }), 'invalid', /machine/);
  // a removed phone starts nothing
  let started = 0;
  host.start = async () => (started++, { chatId: 'y' });
  const client = r.service.phones.get('p1').client;
  r.service.phones.delete('p1');
  await assert.rejects(r.service.call(client, 'chat.start', base), /no longer paired/);
  assert.equal(started, 0);
});
