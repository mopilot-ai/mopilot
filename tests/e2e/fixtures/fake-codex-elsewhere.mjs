// Another Codex client writing a thread of the scripted Codex fixture: finishing the turn it left open, or running a new one.
//   - a seeded thread with `elsewhere` has its last turn still open in another client; that client finishes it once
//     $FAKE_CODEX_LOG.finish-<thread id> appears;
//   - a seeded thread with `rollout` (or `elsewhere`) has a rollout file under $CODEX_HOME/sessions; once
//     $FAKE_CODEX_LOG.external-<thread id> appears, the other client has run a turn on it: its text is the file's
//     content, the reply "other app: <text>", and the file is removed. Append to the rollout file to let the app see it.
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';

export function createFakeCodexElsewhere({ log, textOf, now, saveState }) {
  const agentMessage = (text) => ({
    type: 'agentMessage',
    id: randomUUID(),
    text,
    phase: null,
    memoryCitation: null,
    delivery: null,
    questions: null,
  });

  /** The other client finished its turn once the test says so. */
  function elsewhereDone(rec) {
    const marker = log && rec.elsewhere ? `${log}.finish-${rec.thread.id}` : null;
    if (marker && fs.existsSync(marker)) {
      rec.elsewhere = false;
      const last = rec.turns.at(-1);
      last.items.push(agentMessage(`other app: ${textOf(last.items[0]?.content)}`));
      Object.assign(last, { status: 'completed', completedAt: now(), durationMs: 5 });
    }
    return rec;
  }

  /** The other client ran a whole turn on the thread once the test says so. */
  function otherAppTurn(rec) {
    const marker = log ? `${log}.external-${rec.thread.id}` : null;
    if (!marker || !fs.existsSync(marker)) return rec;
    const text = fs.readFileSync(marker, 'utf8').trim();
    fs.rmSync(marker, { force: true });
    const t = now();
    const user = { type: 'userMessage', id: randomUUID(), clientId: null, content: [{ type: 'text', text, text_elements: [] }] };
    rec.turns.push({
      id: randomUUID(),
      items: [user, agentMessage(`other app: ${text}`)],
      itemsView: 'full',
      status: 'completed',
      error: null,
      startedAt: t,
      completedAt: t,
      durationMs: 5,
    });
    rec.thread.updatedAt = t;
    saveState();
    return rec;
  }

  return { elsewhereDone, otherAppTurn };
}
