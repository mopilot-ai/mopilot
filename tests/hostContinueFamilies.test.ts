// A chat continued to a Host that runs Claude Code, Codex and ACP (#4906, #4911), over the real families and the continue Host: the Host takes each family and binds the chat to the agent it was continued on (A), says which fact holds when it cannot (B), will not let a chat with a turn or waiting messages move and lets the family's turn go when it does (W), and both an older Host and an older app still work (I).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { CONTINUE_CODES as C, CONTINUE_FAMILIES_FEATURE } from '../shared/host/continue.mjs';
import { helloParams } from '../shared/host/schema.mjs';
import { type Agent, AGENTS, base, openAll, until } from './support/host/switchKit.ts';

const FAMILIES: Agent[] = ['claude', 'codex', 'acp'];
/** A chat id spelled as another family's, as a chat that switched agents keeps the id it began with. */
const OTHER_ID: Record<Agent, () => string> = { claude: AGENTS.codex.id, codex: AGENTS.claude.id, acp: AGENTS.claude.id };
/** Where a continue meets a chat: an id spelled as another family's, or as the agent's own (a bare Codex thread id, `claude:<id>`, `acp:<agent>:<id>`). */
const SPELLINGS = ['other', 'own'] as const;
const folder = () => fs.realpathSync(fs.mkdtempSync(path.join(base, 'cwd-')));
const open = (name: string) => openAll(fs.mkdtempSync(path.join(base, `${name}-`)), { claude: true, codex: true }, { continues: true });
const prepare = (h: any, chatId: string, harness: string, p: object = {}) =>
  h.call('chat.prepareContinue', chatId, { harness, cwd: folder(), handoff: 'HANDOFF-RECORD of the earlier talk', ...p });
/** A continue's commit away: this Host as the source. */
const commit = (h: any, chatId: string, epoch: number) =>
  h.call('chat.commitContinue', chatId, { expectedEpoch: epoch, targetHostId: 'B', preparedId: `prepared-${epoch}` });
/** Closes a Host once what its agents were still doing after the last turn (a title, a poll) has gone quiet: a request made as the app-server stops starts another one. */
const closeQuietly = async (h: any) => {
  await new Promise((r) => setTimeout(r, 400));
  await h.close();
};
/** What an agent was sent as a message: the title helper Codex starts after a first turn is not one. */
const messagesOf = (h: any, family: Agent) => (h.prompts[family]() as string[]).filter((t) => !t.startsWith('Summarize the request below'));
const refused = (code: string) => (e: any) => e?.code === code;

for (const family of FAMILIES) {
  for (const spelling of SPELLINGS) {
    test(`A: a ${family} chat whose id spells ${spelling === 'own' ? 'its own agent' : 'another family'} is continued here: the first message goes to ${family} with the handoff, the chat keeps its id and runs on ${family}`, async () => {
      const h = await open(`a-${family}-${spelling}`);
      try {
        const chatId = spelling === 'own' ? AGENTS[family].id() : OTHER_ID[family]();
        const harness = AGENTS[family].harness;
        const prepared: any = await prepare(h, chatId, harness);
        assert.equal(typeof prepared.preparedId, 'string');
        // nothing is bound until the chat is this Host's and its first message comes
        assert.equal(h.sessions.chats.records.has(chatId), false);

        await h.call('chat.subscribe', chatId);
        await h.call('chat.send', chatId, { text: 'FIRST words after the move' });
        await h.idle(chatId, 1);
        assert.equal(h.sessions.controller.ref(chatId).kind, harness, 'the chat runs on the agent it was continued on');
        assert.equal(h.sessions.chatRuntime.familyOf(chatId), family);
        // the session the continue opened is what the Host resumes: a bare Codex thread id has no rollout here
        assert.notEqual(h.sessions.controller.ref(chatId).key, chatId);
        const sent = messagesOf(h, family).at(-1) as string;
        assert.match(sent, /HANDOFF-RECORD/);
        assert.match(sent, /FIRST words after the move/);
        assert.deepEqual(
          h.sessions.chats.record(chatId).segments.map((s: any) => s.kind),
          [harness],
        );
        assert.ok(
          h.lane(chatId).some((p: any) => p.harness === harness),
          'the lane tells the chat’s clients its agent',
        );
        // the handoff is spent: a second message carries only itself
        await h.call('chat.send', chatId, { text: 'SECOND words' });
        await h.idle(chatId, 2);
        assert.doesNotMatch(messagesOf(h, family).at(-1) as string, /HANDOFF-RECORD/);
        assert.equal(h.sessions.chats.record(chatId).segments.length, 1);
      } finally {
        await closeQuietly(h);
      }
    });
  }

  test(`W: a ${family} chat with a turn running, or messages waiting after a Stop, is not let go; once idle it is, its waiting messages and turn end with it, and it can come back with a new session`, async () => {
    const h = await open(`w-${family}`);
    try {
      const chatId = OTHER_ID[family]();
      const harness = AGENTS[family].harness;
      await prepare(h, chatId, harness);
      await h.call('chat.subscribe', chatId);
      await h.call('chat.send', chatId, { text: 'SLOW slow warm up' });
      await until(() => h.sessions.state.snapshot(chatId).turn === 'running');
      // #4911: a turn is running on a family the ACP host does not hold: the commit is refused and nothing is released
      await assert.rejects(commit(h, chatId, 1), refused(C.turnRunning));
      assert.equal(h.epochs.current(chatId), 1);
      // a message waits behind it, and stays after the Stop: still not let go
      await h.call('chat.send', chatId, { text: 'waiting message' });
      await h.call('chat.stop', chatId);
      await until(() => h.sessions.state.snapshot(chatId).turn === 'idle');
      assert.ok(h.sessions.state.snapshot(chatId).queue.length > 0);
      await assert.rejects(commit(h, chatId, 1), refused(C.turnRunning));

      // the chat runs again, then is let go: the Host stops what runs and drops what waits
      await h.call('chat.send', chatId, { text: 'SLOW slow once more' });
      await until(() => h.sessions.state.snapshot(chatId).turn === 'running');
      await h.sessions.chatRuntime.continueRetire(chatId);
      await until(() => h.sessions.state.snapshot(chatId).turn === 'idle');
      assert.deepEqual(h.sessions.state.snapshot(chatId).queue, []);
      assert.equal(h.sessions.chatRuntime.continueBusy(chatId), false);

      // idle with nothing waiting: the commit goes through and the release finalizes it
      const done: any = await commit(h, chatId, 1);
      assert.equal(done.epoch, 2);
      const released: any = await h.call('chat.release', chatId, { epoch: 2, preparedId: 'prepared-1' });
      assert.equal(released.released, 'finalized');
      await assert.rejects(h.call('chat.send', chatId, { text: 'late', epoch: 1 }), refused(C.released));

      // it comes back: a new session of the family, the new handoff in front
      const before = h.sessions.chats.record(chatId).segments[0].nativeId;
      // the same words again (a short handoff can repeat): it is a new continue, so a new session
      await prepare(h, chatId, harness, { epoch: 3 });
      await h.call('chat.send', chatId, { text: 'BACK again', epoch: 3 });
      await until(() => (messagesOf(h, family).at(-1) as string)?.includes('BACK again'));
      const after = h.sessions.chats.record(chatId).segments;
      assert.equal(after.length, 1);
      assert.notEqual(after[0].nativeId, before);
      assert.match(messagesOf(h, family).at(-1) as string, /HANDOFF-RECORD/);
    } finally {
      await closeQuietly(h);
    }
  });
}

for (const family of FAMILIES) {
  test(`W: #4911: a ${family} chat that began on this Host, with a turn running, is not let go to another machine while it runs, and goes once it has stopped`, async () => {
    const h = await open(`w4911-${family}`);
    try {
      const chatId = AGENTS[family].id();
      await h.call('chat.subscribe', chatId);
      await h.call('chat.start', chatId, { harness: AGENTS[family].harness, text: 'SLOW slow start', cwd: folder() });
      await until(() => h.sessions.state.snapshot(chatId).turn === 'running');
      // the commit that went through here before: nothing stopped it and nothing said the turn was running
      await assert.rejects(commit(h, chatId, 1), refused(C.turnRunning));
      assert.equal(h.epochs.current(chatId), 1, 'nothing was released');
      await h.call('chat.stop', chatId);
      await until(() => h.sessions.state.snapshot(chatId).turn === 'idle');
      const done: any = await commit(h, chatId, 1);
      assert.equal(done.epoch, 2);
      // the hand-over finishes
      assert.equal((await h.call('chat.release', chatId, { epoch: 2, preparedId: 'prepared-1' })).released, 'finalized');
    } finally {
      await closeQuietly(h);
    }
  });
}

test('W: a first message refused before it is sent keeps the handoff for the retry', async () => {
  const h = await open('retry');
  try {
    const chatId = AGENTS.codex.id();
    await prepare(h, chatId, 'claude');
    await h.call('chat.subscribe', chatId);
    const bind = h.sessions.chatRuntime.bindContinued;
    h.sessions.chatRuntime.bindContinued = async () => {
      throw Object.assign(new Error('Sign in to Claude Code on this machine.'), { code: 'agent_signed_out' });
    };
    await assert.rejects(h.call('chat.send', chatId, { text: 'first try' }), refused('agent_signed_out'));
    h.sessions.chatRuntime.bindContinued = bind;
    await h.call('chat.send', chatId, { text: 'second try' });
    await h.idle(chatId, 1);
    assert.match(messagesOf(h, 'claude').at(-1) as string, /HANDOFF-RECORD/);
    assert.match(messagesOf(h, 'claude').at(-1) as string, /second try/);
  } finally {
    await closeQuietly(h);
  }
});

test('B: an agent that is not installed, or signed out, is refused by the fact that holds; a lent key or lease counts as signed in', async () => {
  const h = await open('b');
  try {
    const row = (id: string) => h.harnesses.find((x) => x.id === id) as any;
    row('codex').detected = false;
    await assert.rejects(prepare(h, AGENTS.codex.id(), 'codex'), (e: any) => {
      assert.equal(e.code, C.agentMissing);
      assert.deepEqual(e.details, { agent: 'Codex' });
      assert.equal(e.message, "Codex isn't installed on this machine.");
      return true;
    });
    row('codex').detected = true;
    row('claude').signedIn = false;
    row('claude').signIn = ['Claude account', 'API key'];
    await assert.rejects(prepare(h, AGENTS.claude.id(), 'claude'), (e: any) => {
      assert.equal(e.code, C.agentSignedOut);
      assert.deepEqual(e.details, { agent: 'Claude Code', hint: 'Claude account or API key' });
      return true;
    });
    // nothing was prepared by either refusal, and a retry after the fix is not remembered as refused
    // only a key the app lends counts: one that merely exists on the Host does not
    Object.assign(row('claude'), { sources: { key: true, org: true } });
    await assert.rejects(prepare(h, AGENTS.claude.id(), 'claude'), refused(C.agentSignedOut));
    Object.assign(row('claude'), { keyed: true });
    await prepare(h, AGENTS.claude.id(), 'claude');
    // an agent the Host could not check in time is not refused as signed out: the send reports the real cause (#5177)
    Object.assign(row('claude'), { keyed: false, unsure: true });
    await prepare(h, AGENTS.claude.id(), 'claude');
    Object.assign(row('claude'), { unsure: false });
    // a login the agent refused is said so
    Object.assign(row('claude'), { keyed: false, reason: 'login-refused' });
    await assert.rejects(prepare(h, AGENTS.claude.id(), 'claude'), (e: any) => e.code === C.agentSignedOut && e.details.refused === true);
    // an agent this Host does not know is not a fact about an install
    await assert.rejects(prepare(h, AGENTS.acp.id(), 'acp:unknown'), refused('harness_not_configured'));
    // the one signed-out refusal replays under its key: the same retry key still gets the Host's fresh answer
    row('codex').signedIn = false;
    const chatId = AGENTS.codex.id();
    await assert.rejects(prepare(h, chatId, 'codex', { key: 'same-key' }), refused(C.agentSignedOut));
    row('codex').signedIn = true;
    await prepare(h, chatId, 'codex', { key: 'same-key' });
  } finally {
    await closeQuietly(h);
  }
});

for (const [spelled, family] of [
  ['acp:host-claude', 'claude'],
  ['acp:host-codex', 'codex'],
] as const) {
  test(`B: a chat that lives on a Host names its agent as the app draws it (${spelled}): the Host starts it as ${family}`, async () => {
    const h = await open(`b-names-${family}`);
    try {
      const chatId = AGENTS[family].id();
      await prepare(h, chatId, spelled);
      await h.call('chat.subscribe', chatId);
      await h.call('chat.send', chatId, { text: `hello ${family}` });
      await h.idle(chatId, 1);
      assert.equal(h.sessions.controller.ref(chatId).kind, family);
      assert.match(messagesOf(h, family).at(-1) as string, /HANDOFF-RECORD/);
    } finally {
      await closeQuietly(h);
    }
  });
}

test('B: a chat this Host already serves is refused, and a Host that does not run a family says so before anything is kept', async () => {
  const h = await open('b-served');
  const only = await openAll(fs.mkdtempSync(path.join(base, 'b-only-')), { claude: true }, { continues: true });
  try {
    const cwd = folder();
    for (const family of ['claude', 'acp'] as const) {
      const chatId = AGENTS[family].id();
      await h.call('chat.subscribe', chatId);
      await h.call('chat.start', chatId, { harness: AGENTS[family].harness, text: 'mine already', cwd });
      await h.idle(chatId, 1);
      await assert.rejects(prepare(h, chatId, AGENTS[family].harness), refused(C.sameHost));
    }
    // a Host that runs Claude Code only is never bound to a Codex chat
    await assert.rejects(
      only.sessions.chatRuntime.bindContinued({ chatId: AGENTS.codex.id(), harness: 'codex', cwd, text: 'HANDOFF' }),
      /Codex is not available on this Host/,
    );
    // a harness that is no kind of agent binds nothing
    await only.sessions.chatRuntime.bindContinued({ chatId: AGENTS.codex.id(), harness: 'nonsense', cwd, text: 'HANDOFF' });
  } finally {
    await closeQuietly(only);
    await closeQuietly(h);
  }
});

test('A: a Host that restarts between the commit and the first message still has the handoff; the session is made once', async () => {
  const dir = fs.mkdtempSync(path.join(base, 'restart-'));
  const chats = { claude: AGENTS.codex.id(), codex: AGENTS.claude.id() };
  const first = await openAll(dir, { claude: true, codex: true }, { continues: true });
  try {
    for (const family of ['claude', 'codex'] as const) await prepare(first, chats[family], family);
    // a request at the epoch makes this Host the owner, then the Host quits
    for (const family of ['claude', 'codex'] as const) await first.call('chat.subscribe', chats[family]);
  } finally {
    await closeQuietly(first);
  }
  const second = await openAll(dir, { claude: true, codex: true }, { continues: true });
  try {
    for (const family of ['claude', 'codex'] as const) {
      const chatId = chats[family];
      await second.call('chat.subscribe', chatId);
      await second.call('chat.send', chatId, { text: 'after the restart' });
      await second.idle(chatId, 1);
      assert.match(messagesOf(second, family).at(-1) as string, /HANDOFF-RECORD/);
      const made = second.sessions.chats.record(chatId).segments[0].nativeId;
      // the same handoff bound again (a send that was retried) does not make another session
      await second.sessions.chatRuntime.bindContinued({
        chatId,
        harness: family,
        cwd: folder(),
        text: second.sessions.chats.record(chatId).segments[0].handoff.text,
        id: second.sessions.chats.record(chatId).segments[0].handoff.id,
      });
      assert.equal(second.sessions.chats.record(chatId).segments.length, 1);
      assert.equal(second.sessions.chats.record(chatId).segments[0].nativeId, made);
    }
  } finally {
    await closeQuietly(second);
  }
});

test('I: this Host offers the feature that says it takes every family; an app that does not ask for it, and a Host with no continue side, still work as they did', async () => {
  const h = await open('i');
  const plain = await openAll(fs.mkdtempSync(path.join(base, 'i-plain-')));
  try {
    assert.ok(h.agreed.features.includes(CONTINUE_FAMILIES_FEATURE));
    assert.equal(plain.agreed.features.includes(CONTINUE_FAMILIES_FEATURE), false);
    // an older app does not name the feature: the request it sends is the same, and an ACP agent is continued as before
    const old: any = await h.protocol.connection(() => undefined);
    const agreed = (await old.call('host.hello', helloParams({ continueFamilies: false }))).agreed;
    assert.equal(agreed.features.includes(CONTINUE_FAMILIES_FEATURE), false);
    const chatId = AGENTS.acp.id();
    const prepared = await old.call('chat.prepareContinue', {
      chatId,
      epoch: 1,
      key: 'old-app-key',
      harness: 'acp:fake',
      cwd: folder(),
      handoff: 'HANDOFF-RECORD',
    });
    assert.equal(typeof prepared.preparedId, 'string');
    await old.call('chat.subscribe', { chatId, epoch: 1 });
    await old.call('chat.send', { chatId, epoch: 1, key: 'old-app-send', text: 'hello from the old app' });
    await until(() => messagesOf(h, 'acp').some((t) => t.includes('hello from the old app')));
    assert.match(messagesOf(h, 'acp').at(-1) as string, /HANDOFF-RECORD/);
    // the continue's own session is the chat's, whatever its id spells
    assert.equal(h.sessions.chats.records.get(chatId).segments.length, 1);
  } finally {
    await closeQuietly(plain);
    await closeQuietly(h);
  }
});
