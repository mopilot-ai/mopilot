// The first turn after a switch to Codex on a Host whose Codex answers at once (J8's stand-in app-server, #4278): the app-server reports the turn over before the reply to `turn/start` is read, and the stream must still tell one start and one end of each turn, in that order, to the Host's clients and to the Mac's mirror, so the chat leaves the running state. Codex keeps no native history here, as J8's does, so the handoff from it names only the workspace.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { type Agent, AGENTS, base, openAll, until } from './support/host/switchKit.ts';
import { FakeItems, createRemoteChats, fakeHost, tick } from './support/host/remoteChatsKit.ts';

const pairs: [Agent, Agent][] = [
  ['claude', 'codex'],
  ['acp', 'codex'],
  ['codex', 'acp'],
  ['codex', 'claude'],
];

for (const [from, to] of pairs) {
  test(`J8: a ${from} chat moved to ${to} (with a message that stayed in between) ends every turn it starts, on the Host's stream and in the Mac's mirror`, async () => {
    const dir = fs.mkdtempSync(`${base}/j-`);
    const cwd = fs.realpathSync(fs.mkdtempSync(`${base}/cwd-`));
    const h = await openAll(dir, { claude: true, codex: true }, { history: false });
    try {
      const chatId = AGENTS[from].id();
      await h.call('chat.subscribe', chatId);
      await h.call('chat.start', chatId, { harness: AGENTS[from].harness, text: `first-${from}`, cwd });
      await h.idle(chatId, 1);
      // a choice, taken back, a message that stays, the choice again, and the message that settles it
      await h.call('chat.switch', chatId, { harness: AGENTS[to].harness });
      await h.call('chat.switch', chatId, { harness: AGENTS[from].harness });
      await h.call('chat.send', chatId, { text: `stay-${from}` });
      await h.idle(chatId, 2);
      await h.call('chat.switch', chatId, { harness: AGENTS[to].harness });
      await h.call('chat.send', chatId, { text: `moved-${to}` });
      await h.idle(chatId, 3);
      await until(() => h.sessions.state.snapshot(chatId).turn === 'idle');

      // the Host's own stream: each turn starts once and its end is the last word of it
      const durable = h.frames.filter((m: any) => m.chatId === chatId && m.frame?.t === 'durable').map((m: any) => m.frame);
      const events = durable.filter((f: any) => f.item?.t === 'event').map((f: any) => f.item.event);
      const turns = new Map<string, string[]>();
      for (const e of events)
        if (e.turnId && ['turnStart', 'update', 'turnEnd'].includes(e.kind)) turns.set(e.turnId, [...(turns.get(e.turnId) ?? []), e.kind]);
      for (const [turnId, kinds] of turns) {
        assert.equal(kinds.filter((k) => k === 'turnStart').length, 1, `turn ${turnId} starts once: ${kinds}`);
        assert.equal(kinds.at(-1), 'turnEnd', `turn ${turnId} ends last: ${kinds}`);
      }

      // the Mac's mirror of the same stream ends up with every turn it started over
      const MAC = 'acp:host-x:mac1';
      const host = fakeHost();
      const emitted: any[] = [];
      const mirror = createRemoteChats({
        items: new FakeItems(),
        hostFor: () => host,
        ownerOf: () => ({ hostId: 'm1', folder: '/srv/work' }),
        emit: (e: any) => emitted.push(e),
        state: () => ({ get: () => ({}), patch: () => undefined }),
        now: () => 1000,
        report: () => undefined,
      });
      mirror.follow(MAC);
      await mirror.settled(MAC);
      for (const m of h.frames) {
        if (m.chatId !== chatId || m.event !== 'frame') continue;
        const fr = m.frame;
        if (fr.t === 'durable') host.fire.patch(MAC, fr.rev, fr.item, fr.promotes);
        else if (fr.t === 'delta') host.fire.delta(MAC, fr.key, fr.delta);
        else host.fire.frame(MAC, fr);
        await tick();
      }
      await mirror.settled(MAC);
      const starts = emitted.filter((e) => e.kind === 'turnStart').length;
      const ends = emitted.filter((e) => e.kind === 'turnEnd').length;
      assert.equal(starts, ends, 'the Mac saw as many ends as starts');
      assert.equal(emitted.findLast((e) => e.kind === 'turnStart' || e.kind === 'turnEnd').kind, 'turnEnd', 'and the last word was an end');
    } finally {
      await h.close();
    }
  });
}
