// J8's Codex → fake ACP (#4278): the message that settles a switch is sent with the old agent's model and effort (the Mac freezes them with the message), and the new agent may not offer them. The Host runs it on the held choice's model and effort, so the new agent is sent its prompt instead of refusing the turn.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { AGENTS, base, openAll, until } from './support/host/switchKit.ts';
import { settlingPick } from '../host/src/hostSwitch.mjs';

for (const history of [true, false]) {
  test(`J8: a Codex chat moved to an ACP agent that offers one model is sent its prompt although the message carries Codex's model (native Codex history: ${history})`, async () => {
    const dir = fs.mkdtempSync(`${base}/m-`);
    const cwd = fs.realpathSync(fs.mkdtempSync(`${base}/cwd-`));
    const h = await openAll(dir, { claude: true, codex: true }, { history, acpModels: true });
    try {
      const chatId = AGENTS.codex.id();
      await h.call('chat.subscribe', chatId);
      await h.call('chat.start', chatId, { harness: 'codex', text: 'first-codex', cwd, model: 'gpt-fake', effort: 'low' });
      await h.idle(chatId, 1);
      // a choice taken back, a message that stays (still on Codex's model), the choice again
      await h.call('chat.switch', chatId, { harness: 'acp:fake', model: 'fake-1' });
      await h.call('chat.switch', chatId, { harness: 'codex' });
      await h.call('chat.permit', chatId, { value: 'default' });
      await h.call('chat.send', chatId, { text: 'stay-codex', model: 'gpt-fake', effort: 'low' });
      await h.idle(chatId, 2);
      await h.call('chat.switch', chatId, { harness: 'acp:fake', model: 'fake-1' });
      // the message that settles it, as the Mac sends it: the chat's own pick is still Codex's
      const sent: any = await h.call('chat.send', chatId, { text: 'moved-fake', model: 'gpt-fake', effort: 'low' });
      assert.equal(sent.result.error, undefined, `the receipt says no error: ${sent.result.error}`);
      assert.equal(sent.result.action, 'started');
      await until(() => h.prompts.acp().length > 0);
      assert.match(h.prompts.acp()[0], /moved-fake/);
      assert.equal(h.sessions.state.snapshot(chatId).turn === 'crashed', false);
      await h.idle(chatId, 3);
    } finally {
      await h.close();
    }
  });
}

test("the model and effort a message runs with are its own, or, while a switch is held, the held choice's", () => {
  const pick = { model: 'gpt-fake', effort: 'low' };
  assert.equal(settlingPick(null, pick), pick);
  assert.equal(settlingPick(undefined, undefined), undefined);
  assert.deepEqual(settlingPick({ model: 'fake-1', effort: 'high' }, pick), { model: 'fake-1', effort: 'high' });
  assert.deepEqual(settlingPick({ model: 'fake-1' }, pick), { model: 'fake-1' });
  assert.deepEqual(settlingPick({ model: '', effort: null }, pick), {}, 'a choice that names none leaves the new agent its own default');
});
