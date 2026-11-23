// A Codex chat moved to a Host, then its next message (#5160): the thread the Host started for the move has no rollout until that message, so a real Codex answers a resume of it "no rollout found". The fake Codex is strict about that here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { AGENTS, base, openAll } from './support/host/switchKit.ts';

const folder = () => fs.realpathSync(fs.mkdtempSync(path.join(base, 'cwd-')));
const open = (name: string, credentials = true) =>
  openAll(fs.mkdtempSync(path.join(base, `${name}-`)), { claude: true, codex: true }, { continues: true, strictResume: true, credentials });
const closeQuietly = async (h: any) => {
  await new Promise((r) => setTimeout(r, 400));
  await h.close();
};
const moved = (h: any, chatId: string) =>
  h.call('chat.prepareContinue', chatId, { harness: 'codex', cwd: folder(), handoff: 'HANDOFF-RECORD of the earlier talk' });

test('a moved Codex chat whose Codex restarted before its first message answers it: the thread with no rollout is replaced, with the handoff as context', async () => {
  const h = await open('resume-restart');
  try {
    const chatId = AGENTS.codex.id();
    await moved(h, chatId);
    const runtime = h.sessions.chatRuntime;
    const bind = runtime.bindContinued.bind(runtime);
    // Codex quits (an update, a lent key renewed, a crash) after the chat's thread was started and before its first message
    runtime.bindContinued = async (p: any) => {
      await bind(p);
      h.made.codex.codex.server.stop();
      await new Promise((r) => setTimeout(r, 300));
    };
    await h.call('chat.subscribe', chatId);
    await h.call('chat.send', chatId, { text: 'FIRST words after the move' });
    await h.idle(chatId, 1);
    const sent = h.prompts.codex().at(-1) as string;
    assert.match(sent, /HANDOFF-RECORD/);
    assert.match(sent, /FIRST words after the move/);
  } finally {
    await closeQuietly(h);
  }
});

test('a moved Codex chat whose Host restarted before its first message was sent answers it: the session its handoff started is started again', async () => {
  const dir = fs.mkdtempSync(path.join(base, 'resume-host-'));
  const first = await openAll(dir, { claude: true, codex: true }, { continues: true, strictResume: true });
  const chatId = AGENTS.codex.id();
  try {
    await moved(first, chatId);
    const runtime = first.sessions.chatRuntime;
    const bind = runtime.bindContinued.bind(runtime);
    // the Host goes down once the chat's session is started, before its first message goes
    runtime.bindContinued = async (p: any) => {
      await bind(p);
      throw new Error('Host stopped');
    };
    await assert.rejects(first.call('chat.send', chatId, { text: 'FIRST words after the move' }), /Host stopped/);
  } finally {
    await closeQuietly(first);
  }
  const second = await openAll(dir, { claude: true, codex: true }, { continues: true, strictResume: true });
  try {
    await second.call('chat.subscribe', chatId);
    await second.call('chat.send', chatId, { text: 'FIRST words after the move' });
    await second.idle(chatId, 1);
    const sent = second.prompts.codex().at(-1) as string;
    assert.match(sent, /HANDOFF-RECORD/);
    assert.match(sent, /FIRST words after the move/);
  } finally {
    await closeQuietly(second);
  }
});

// the other families' equivalent: a Host that restarts after a continue started the chat's session and before its first message goes
for (const family of ['acp', 'claude'] as const) {
  test(`a moved ${family} chat whose Host restarted before its first message was sent answers it with the handoff`, async () => {
    const dir = fs.mkdtempSync(path.join(base, `resume-${family}-`));
    const first = await openAll(dir, { claude: true, codex: true }, { continues: true, strictResume: true });
    const chatId = AGENTS[family].id();
    try {
      await first.call('chat.prepareContinue', chatId, {
        harness: AGENTS[family].harness,
        cwd: folder(),
        handoff: 'HANDOFF-RECORD of the earlier talk',
      });
      const runtime = first.sessions.chatRuntime;
      const bind = runtime.bindContinued.bind(runtime);
      runtime.bindContinued = async (p: any) => {
        await bind(p);
        throw new Error('Host stopped');
      };
      await assert.rejects(first.call('chat.send', chatId, { text: 'FIRST words after the move' }), /Host stopped/);
    } finally {
      await closeQuietly(first);
    }
    const second = await openAll(dir, { claude: true, codex: true }, { continues: true, strictResume: true });
    try {
      await second.call('chat.subscribe', chatId);
      await second.call('chat.send', chatId, { text: 'FIRST words after the move' });
      await second.idle(chatId, 1);
      const sent = second.prompts[family]().at(-1) as string;
      assert.match(sent, /HANDOFF-RECORD/);
      assert.match(sent, /FIRST words after the move/);
    } finally {
      await closeQuietly(second);
    }
  });
}

test('a moved Codex chat the app names as a Host chat (a v4 id, the harness acp:host-codex) answers its next message', async () => {
  const h = await open('resume-appname');
  try {
    const chatId = crypto.randomUUID();
    await h.call('chat.prepareContinue', chatId, {
      harness: 'acp:host-codex',
      cwd: folder(),
      handoff: 'HANDOFF-RECORD of the earlier talk',
    });
    await h.call('chat.subscribe', chatId);
    await h.call('chat.send', chatId, { text: 'FIRST words after the move', cwd: folder(), model: 'm1' });
    await h.idle(chatId, 1);
    assert.match(h.prompts.codex().at(-1) as string, /HANDOFF-RECORD/);
  } finally {
    await closeQuietly(h);
  }
});

test('a Codex chat continued under the app’s id (acp:host-codex:<uuid>) answers its first message sent under the Host’s id (<uuid>)', async () => {
  const h = await open('resume-appid');
  try {
    const uuid = crypto.randomUUID();
    const appId = `acp:host-codex:${uuid}`;
    // the app's continue machine asks the Host with the id the app uses; its sends go through the Host-id view
    await h.call('chat.prepareContinue', appId, {
      harness: 'acp:host-codex',
      cwd: folder(),
      handoff: 'HANDOFF-RECORD of the earlier talk',
    });
    await h.call('chat.subscribe', appId);
    await h.call('chat.subscribe', uuid);
    await h.call('chat.send', uuid, { text: 'FIRST words after the move', cwd: folder() });
    await h.idle(uuid, 1);
    assert.match(h.prompts.codex().at(-1) as string, /HANDOFF-RECORD/);
  } finally {
    await closeQuietly(h);
  }
});

test('a Claude Code chat continued under the app’s id gets its handoff under the Host’s id too; a hello that names the chat as the app does is answered in the same spelling', async () => {
  const h = await open('resume-appid-claude');
  try {
    const uuid = crypto.randomUUID();
    await h.call('chat.prepareContinue', `acp:host-claude:${uuid}`, {
      harness: 'acp:host-claude',
      cwd: folder(),
      handoff: 'HANDOFF-RECORD of the earlier talk',
    });
    await h.call('chat.subscribe', `claude:${uuid}`);
    await h.call('chat.send', `claude:${uuid}`, { text: 'FIRST words after the move', cwd: folder() });
    await h.idle(`claude:${uuid}`, 1);
    assert.match(h.prompts.claude().at(-1) as string, /HANDOFF-RECORD/);
    // the app moved a chat away while this Host was gone: it is poisoned under the Host's id, and the answer names it as the app did
    const other = `acp:host-codex:${crypto.randomUUID()}`;
    const answer = await h.wiring?.continueHost.acceptHello([{ chatId: other, epoch: 5, rev: 0, targetHostId: 'B' }]);
    assert.deepEqual(
      answer?.poisoned.map((p: any) => p.chatId),
      [other],
    );
    const owned = await h
      .call('chat.commitContinue', other, { expectedEpoch: 5, targetHostId: 'B', preparedId: 'none' })
      .catch((e: any) => e);
    assert.ok(owned instanceof Error, 'a chat poisoned under the app id is refused under it too');
  } finally {
    await closeQuietly(h);
  }
});

test('a moved Codex chat whose mode is set before its first message answers it', async () => {
  const h = await open('resume-permit');
  try {
    const chatId = AGENTS.codex.id();
    await moved(h, chatId);
    await h.call('chat.subscribe', chatId);
    await h.call('chat.permit', chatId, { value: 'default' });
    await h.call('chat.send', chatId, { text: 'FIRST words after the move' });
    await h.idle(chatId, 1);
    const sent = h.prompts.codex().at(-1) as string;
    assert.match(sent, /HANDOFF-RECORD/);
  } finally {
    await closeQuietly(h);
  }
});

for (const spelling of ['own', 'other'] as const) {
  test(`a Codex chat (${spelling} id) moved to a Host answers its next message: nothing resumes a thread with no rollout`, async () => {
    const h = await open(`resume-${spelling}`);
    try {
      const chatId = spelling === 'own' ? AGENTS.codex.id() : AGENTS.claude.id();
      await moved(h, chatId);
      await h.call('chat.subscribe', chatId);
      await h.call('chat.send', chatId, { text: 'FIRST words after the move' });
      await h.idle(chatId, 1);
      const sent = h.prompts.codex().at(-1) as string;
      assert.match(sent, /HANDOFF-RECORD/);
      assert.match(sent, /FIRST words after the move/);
    } finally {
      await closeQuietly(h);
    }
  });
}
