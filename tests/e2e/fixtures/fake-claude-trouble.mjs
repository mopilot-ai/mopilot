// Turns of the fake Claude CLI that end in provider trouble the way the CLI reports it, and an approval asked late.
//   - "PROVIDERRETRY": a finished Read step, then system/api_retry every 300 ms until interrupted, as the CLI retries a
//     failing API. A later PROVIDERRETRY turn of the same session has the step's result in its history, as the model
//     would, so it answers without reading again. Each Read is logged as {kind: 'tool', name: 'Read'};
//   - "ORGBLOCKED": the provider refuses the login for its organization (403 oauth_not_allowed_for_organization): the turn ends on the CLI's sentence for it;
//   - "LOGINEXPIRED": the login's token lapses (".fake-expired" in its folder, see fake-claude-limits.mjs) and the turn
//     ends on the CLI's authentication error;
//   - "REFUSE": the model refuses the request: an error reply with stop reason `refusal` and a failed result (fake-claude-limits.mjs);
//   - "WARN" / "WARN7D" / "WARNCLEAR": a rate_limit_event that says the five-hour (weekly) window is nearly used up (allowed_warning), or that
//     both windows are allowed again (one event each), ahead of the turn's ordinary reply;
//   - "RUNCMDLATER": waits until "$FAKE_CLAUDE_LOG.ask" exists (and removes it), then asks to run `rm -rf build`, so a
//     message can be queued before the card shows; the decision goes in the reply as [command: ran|declined].
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { reportsUsageWindows, usageWindowsEvent, warningEvents, refusedRequest, refusedTurn } from './fake-claude-limits.mjs';

const ZERO = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };

export function createFakeClaudeTrouble({
  sessionId,
  configDir,
  logFile,
  send,
  record,
  result,
  log,
  toolRound,
  authFailed,
  onInterrupt,
  sleep,
}) {
  const base = { parent_tool_use_id: null, session_id: sessionId };
  const toolUse = (content) => ({
    id: `msg_fake_${randomUUID().replace(/-/g, '').slice(0, 20)}`,
    type: 'message',
    role: 'assistant',
    model: 'claude-sonnet-4-5',
    content,
    stop_reason: 'tool_use',
    stop_sequence: null,
    usage: ZERO,
  });
  const readDone = path.join(configDir, `.fake-read-${sessionId}`);
  async function providerRetry(started) {
    if (fs.existsSync(readDone)) return ' [read already done]';
    const id = `toolu_fake_${randomUUID().slice(0, 8)}`;
    const use = toolUse([{ type: 'tool_use', id, name: 'Read', input: { file_path: `${process.cwd()}/README.md` } }]);
    let uuid = randomUUID();
    record('assistant', { message: use, uuid });
    send({ type: 'assistant', message: use, ...base, uuid });
    log({ kind: 'tool', name: 'Read' });
    fs.writeFileSync(readDone, '');
    const content = [{ type: 'tool_result', tool_use_id: id, content: '# README' }];
    uuid = randomUUID();
    record('user', { message: { role: 'user', content }, uuid });
    send({ type: 'user', message: { role: 'user', content }, ...base, uuid });
    let stopped = false;
    onInterrupt(() => (stopped = true));
    for (let attempt = 1; !stopped; attempt++) {
      send({
        type: 'system',
        subtype: 'api_retry',
        attempt,
        max_retries: 10,
        retry_delay_ms: 300,
        error_status: 529,
        error: 'overloaded_error',
        ...base,
        uuid: randomUUID(),
      });
      await sleep(300);
    }
    onInterrupt(null);
    record('user', { message: { role: 'user', content: [{ type: 'text', text: '[Request interrupted by user]' }] }, uuid: randomUUID() });
    result(started, true, '', ZERO);
    return null;
  }

  async function runCmdLater() {
    const marker = `${logFile}.ask`;
    while (!fs.existsSync(marker)) await sleep(50);
    fs.rmSync(marker, { force: true });
    const d = await toolRound('Bash', { command: 'rm -rf build' }, () => ({ text: 'removed', structured: { stdout: '', stderr: '' } }));
    return ` [command: ${d === 'allow' ? 'ran' : 'declined'}]`;
  }

  /**
   * The turn's trouble, if its text asks for one: a suffix for the turn's reply, or null when it ended the turn itself;
   * '' when the text asks for none.
   */
  async function trouble(text, started) {
    // every ordinary turn of a login that reports its windows says so first, as a newer CLI does
    if (reportsUsageWindows(configDir)) send(usageWindowsEvent(sessionId));
    for (const warning of warningEvents(sessionId, text)) send(warning);
    // the provider refuses the login for its organization: the turn ends on the CLI's own words for it (#4908)
    if (text.includes('ORGBLOCKED')) {
      refusedTurn({ send, record, sessionId }, started, 'blocked');
      return null;
    }
    if (text.includes('REFUSE')) {
      refusedRequest({ send, record, sessionId }, started);
      return null;
    }
    if (text.includes('PROVIDERRETRY')) return providerRetry(started);
    if (text.includes('RUNCMDLATER')) return runCmdLater();
    if (!text.includes('LOGINEXPIRED')) return '';
    fs.writeFileSync(path.join(configDir, '.fake-expired'), '');
    authFailed(started);
    return null;
  }

  return { trouble };
}
