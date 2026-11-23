// Provider trouble for scripted Codex: quiet before its first token, recovering/failed streams, and a lapsed login.
//   - "PROVIDERRETRY": runs `npm run lint` (a finished command step, logged as fake/command), then sends the willRetry
//     `error` notification Codex sends while it retries a failing provider, every 300 ms, until turn/interrupt. A
//     later PROVIDERRETRY turn on the same thread has the command's output in its history, as the model would, so it
//     answers at once without running it again;
//   - "LOGINEXPIRED": the app-server's own login lapses: the turn fails with unauthorized and it is signed out
//     (account/updated);
//   - "REFUSE": the model's policy refuses the turn: it fails with codexErrorInfo cyberPolicy;
//   - "NOMODEL": the thread's first such turn fails as Codex does for a model the plan doesn't include ('fake-model-2');
//     a later one (the retry on another model, which the spec reads from turn/start) answers as usual;
//   - "WARN" / "WARN7D" / "WARNCLEAR": an account/rateLimits/updated that has the five-hour (weekly) window at 90% (both windows low), then the
//     turn's ordinary reply. A usage limit ("USAGELIMIT") and a 401 the client refreshes ("AUTHEXPIRED") are fake-codex-accounts.mjs.
import { randomUUID } from 'node:crypto';

export const TROUBLE = /QUIETTURN|PROVIDERRETRY|PROVIDERFAIL|LOGINEXPIRED|REFUSE|NOMODEL|\bWARN(7D|CLEAR)?\b/;

export function createFakeCodexTrouble({ notify, log, saveState, waiting, signOut, now, sleep }) {
  const agentMessage = (text) => ({
    type: 'agentMessage',
    id: randomUUID(),
    text,
    phase: null,
    memoryCitation: null,
    delivery: null,
    questions: null,
  });
  function finish(rec, turn, status, error = null) {
    const threadId = rec.thread.id;
    Object.assign(turn, { status, error, completedAt: now(), durationMs: Math.max(1, Date.now() - turn.startedAt * 1000) });
    if (error) notify('error', { threadId, turnId: turn.id, willRetry: false, error });
    rec.thread.status = { type: 'idle' };
    rec.running = null;
    saveState();
    notify('turn/completed', { threadId, turn: { ...turn, items: [...turn.items] } });
    notify('thread/status/changed', { threadId, status: rec.thread.status });
  }
  function push(rec, turn, item) {
    turn.items.push(item);
    notify('item/started', { item: { ...item }, threadId: rec.thread.id, turnId: turn.id, startedAtMs: Date.now() });
    notify('item/completed', { item: { ...item }, threadId: rec.thread.id, turnId: turn.id, completedAtMs: Date.now() });
  }
  const ranTests = (rec) =>
    rec.turns.some((t) => t.items.some((i) => i.type === 'commandExecution' && i.command === 'npm run lint' && i.status === 'completed'));

  async function providerRetry(rec, turn, text) {
    const threadId = rec.thread.id;
    const turnId = turn.id;
    if (ranTests(rec)) {
      push(rec, turn, agentMessage(`fake-codex: ${text} [lint already ran]`));
      return finish(rec, turn, 'completed');
    }
    log({ id: null, method: 'fake/command', params: { threadId, command: 'npm run lint' } });
    push(rec, turn, {
      type: 'commandExecution',
      id: randomUUID(),
      command: 'npm run lint',
      cwd: rec.thread.cwd,
      processId: null,
      source: 'agent',
      status: 'completed',
      commandActions: [],
      aggregatedOutput: 'no problems',
      exitCode: 0,
      durationMs: 1,
    });
    saveState();
    let stopped = false;
    waiting.set(turnId, () => (stopped = true));
    for (let attempt = 1; !stopped; attempt++) {
      notify('error', {
        threadId,
        turnId,
        willRetry: true,
        error: {
          message: `Reconnecting... ${attempt}/5`,
          codexErrorInfo: { responseStreamDisconnected: { httpStatusCode: null } },
          additionalDetails: 'stream disconnected before completion',
        },
      });
      await sleep(300);
      if (text.includes('PROVIDERFAIL') && attempt === 3 && !stopped) {
        waiting.delete(turnId);
        return finish(rec, turn, 'failed', { message: 'The provider could not finish the response.', additionalDetails: null });
      }
    }
    finish(rec, turn, 'interrupted');
  }

  /** Codex's rolling rate limits: the window `hot` ('5h' or '7d', none for both low) at 90%, its reset an hour (a day) away. */
  const rateLimits = (hot) => {
    const at = Math.floor(Date.now() / 1000);
    return {
      limitId: 'codex',
      limitName: null,
      primary: { usedPercent: hot === '5h' ? 90 : 20, windowDurationMins: 300, resetsAt: at + 3600 },
      secondary: { usedPercent: hot === '7d' ? 90 : 10, windowDurationMins: 10080, resetsAt: at + 86400 },
      credits: null,
      planType: null,
      rateLimitReachedType: null,
    };
  };

  /** The turn's trouble, answered in place of runTurn's reply. */
  return async function trouble(rec, turn, text) {
    if (/\bWARN(7D|CLEAR)?\b/.test(text)) {
      const hot = text.includes('WARNCLEAR') ? null : text.includes('WARN7D') ? '7d' : '5h';
      notify('account/rateLimits/updated', { rateLimits: rateLimits(hot) });
      push(rec, turn, agentMessage(`fake-codex: ${text}`));
      return finish(rec, turn, 'completed');
    }
    if (text.includes('NOMODEL')) {
      await sleep(15);
      if (rec.noModelShown) {
        push(rec, turn, agentMessage(`fake-codex: ${text}`));
        return finish(rec, turn, 'completed');
      }
      rec.noModelShown = true;
      return finish(rec, turn, 'failed', {
        message: "The 'fake-model-2' model is not supported when using Codex with a ChatGPT account.",
        codexErrorInfo: 'badRequest',
        additionalDetails: null,
      });
    }
    if (text.includes('REFUSE')) {
      await sleep(15);
      return finish(rec, turn, 'failed', {
        message: 'This request was flagged by the safety checks.',
        codexErrorInfo: 'cyberPolicy',
        additionalDetails: null,
      });
    }
    if (text.includes('QUIETTURN')) {
      await new Promise((resolve) => waiting.set(turn.id, resolve));
      waiting.delete(turn.id);
      return finish(rec, turn, 'interrupted');
    }
    if (/PROVIDERRETRY|PROVIDERFAIL/.test(text)) return providerRetry(rec, turn, text);
    await sleep(15);
    signOut();
    finish(rec, turn, 'failed', {
      message: 'Your access token could not be refreshed because your refresh token has expired. Please log out and sign in again.',
      codexErrorInfo: 'unauthorized',
      additionalDetails: null,
      misalignment: null,
    });
  };
}
