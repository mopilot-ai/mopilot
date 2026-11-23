// ACP prompt dispatch owns start cancellation, inherited permissions and the current native prompt's recorded lifetime.
const { RpcError } = require('./rpc.cjs');
const crypto = require('node:crypto');
const { assertInputCurrent, assertInputReady, hasInputReadiness } = require('../../session/contract/inputGuard.cjs');
const { applyLinkedPermission } = require('./linkedSettings.cjs');
const { applyInitialConfig } = require('./initialConfig.cjs');
const { momoLiteralText } = require('../../../shared/momoCommands.mjs');

async function sendPrompt(host, key, p, meta = {}) {
  // starting the agent, its privacy check and loading the session can take a while: Stop meanwhile is remembered
  const start = { cancelled: false };
  host.starting.set(key, start);
  let chat;
  const current = () => {
    if (start.cancelled) throw new Error('Stopped before the message was sent');
    assertInputCurrent(meta);
  };
  try {
    chat = await host.ensure(key, { cwd: p.cwd, chatId: meta.chatId });
    current();
    await applyLinkedPermission(host, chat, p.initialPermission, current);
    current();
    // p.config: the message's model and effort (a scheduled task's run), set on the session before it goes
    await applyInitialConfig(host, chat, p.config, current);
    if (hasInputReadiness(meta)) await assertInputReady(meta);
    current();
  } finally {
    if (host.starting.get(key) === start) host.starting.delete(key);
  }
  if (chat.prompting) throw new Error(`${host.label(chat.harness)} is still working on the last message`);
  // Ordinary MoMo text stays literal; a structured compaction action is native maintenance.
  const given = Array.isArray(p.blocks) ? p.blocks : [];
  const blocks =
    chat.isolated && !meta.compact ? given.map((b) => (b?.type === 'text' ? { ...b, text: momoLiteralText(b.text) } : b)) : given;
  if (!chat.agent.caps.image && blocks.some((b) => b?.type === 'image')) throw new Error(`${host.label(chat.harness)} can't take images`);
  const audio = blocks.some((b) => b?.type === 'audio');
  if (audio && chat.agent.caps.audio !== true) throw new Error(`${host.label(chat.harness)} has not declared support for audio messages`);
  const clientId = typeof meta.uuid === 'string' && meta.uuid ? meta.uuid : crypto.randomUUID();
  const turnId = `at-${clientId}`;
  const audioIntent = audio ? host.audioDispatch.begin(key, clientId, p.display, host.now()) : null;
  const run = { turnId, cancelled: false, audio, audioIntent, audioResponse: false };
  chat.prompting = run;
  const user = { id: `u-${clientId}`, clientId, content: Array.isArray(p.display) ? p.display : [] };
  host.items.append(key, { t: 'user', turnId, user, at: host.now() });
  host.emitEvent({ key, kind: 'turnStart', turnId, user, human: !!meta.human, cwd: chat.cwd });
  chat.agent.request('session/prompt', { sessionId: chat.sessionId, prompt: blocks }).then(
    (res) => {
      run.audioResponse = true;
      if (host.admission?.acceptsBin?.(chat.harness, chat.agent.command, chat.agent.binaryStamp) !== false) host.signedInFn(chat.harness);
      host.finish(chat, res?.stopReason ?? 'end_turn', null, run, { usage: res?.usage });
    },
    (cause) => {
      run.audioResponse = cause instanceof RpcError;
      const e = host.authFailed(chat.harness, cause, 'session/prompt', chat.agent);
      host.finish(chat, null, String(e?.message ?? e), run);
    },
  );
  return { turnId, ...(audio ? { delivery: 'dispatched' } : {}) };
}

module.exports = { sendPrompt };
