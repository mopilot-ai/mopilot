// The fake Claude Code's prompt queue: each prompt runs as a turn, and a FOLDSTEER one folds a steer sent meanwhile into itself like the real CLI (#1834).
import { randomUUID } from 'node:crypto';

/**
 * Runs the queued prompts. A prompt with FOLDSTEER reports session_state_changed running, and the prompts queued while it ran
 * join its turn: one result answers them all (runTurn sends it), then the CLI reports idle.
 */
export async function drainQueue(queue, runTurn, { send, record, sessionId, textOf }) {
  const state = (value) =>
    send({ type: 'system', subtype: 'session_state_changed', state: value, session_id: sessionId, uuid: randomUUID() });
  while (queue.length) {
    const msg = queue.shift();
    const folds = textOf(msg.message?.content).includes('FOLDSTEER');
    if (folds) state('running');
    await runTurn(msg);
    if (!folds) continue;
    for (const steer of queue.splice(0))
      record('user', { message: { role: 'user', content: steer.message?.content ?? '' }, uuid: steer.uuid || randomUUID() });
    state('idle');
  }
}
