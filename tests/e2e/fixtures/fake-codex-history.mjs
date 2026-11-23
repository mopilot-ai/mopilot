// A real-protocol history snapshot can race with a live item; the next read contains that item's newer durable text.
import fs from 'node:fs';

export const HISTORY_DELTA = ' Continued while history loaded.';

export function createFakeCodexHistory({ getThread, otherAppTurn, elsewhereDone, notify, saveState, log, record, send }) {
  const delayed = new WeakSet();
  const read = (p) => {
    const rec = otherAppTurn(elsewhereDone(getThread(p.threadId)));
    const all = [...rec.turns].reverse();
    const [from, end] = [Number(p.cursor) || 0, (Number(p.cursor) || 0) + (p.limit || all.length)];
    const page = structuredClone({ data: all.slice(from, end), nextCursor: end < all.length ? String(end) : null, backwardsCursor: null });
    const marker = log && `${log}.history-race-${p.threadId}`;
    const turn = rec.turns.at(-1);
    const agent = turn?.items.findLast((item) => item.type === 'agentMessage');
    if (marker && fs.existsSync(marker) && turn?.status === 'inProgress' && agent) {
      fs.rmSync(marker);
      agent.text += HISTORY_DELTA;
      saveState();
      notify('item/completed', { threadId: p.threadId, turnId: turn.id, item: structuredClone(agent) });
      record({ method: 'fixture/historyRace', params: { threadId: p.threadId } });
      delayed.add(page);
    }
    return page;
  };
  read.reply = (message) => {
    // The native dispatcher remains synchronous; only this captured page waits for the live item to commit.
    if (delayed.delete(message.result)) setTimeout(() => send(message), 100);
    else send(message);
  };
  return read;
}
