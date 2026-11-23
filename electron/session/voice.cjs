// Main-owned native conversation writers exclude ordinary sends and retain their original lease through closure.
const { busy } = require('./controllerEvents.cjs');
const { ignoring } = require('../ignored.cjs');
const { guardSend } = require('./contract/inputGuard.cjs');
const { voiceDeadline } = require('./voiceDeadline.cjs');
const writers = new WeakMap();
const byAdapter = new WeakMap();

function voiceWriter(controller, chatId) {
  return writers.get(controller)?.get(chatId) ?? null;
}

/** Reserve synchronously after capability checks, before the first native write. */
async function startVoice({ controller, caps, codex, current = () => true, timeoutMs = 20_000 }, params) {
  const chatId = controller.chatOf(String(params?.threadId ?? ''));
  const available = await voiceDeadline(caps.get(chatId), timeoutMs);
  const ref = controller.ref(chatId);
  if (
    !current() ||
    !ref ||
    ref.key !== params?.threadId ||
    controller.adapterFor(ref.kind) !== codex ||
    available?.kind !== ref.kind ||
    available.caps.voiceChat.state !== 'native'
  )
    throw new Error('Native voice conversation is unavailable for this chat or account.');
  const state = controller.state.get(chatId);
  if (voiceWriter(controller, chatId) || busy(state) || state.runningElsewhere || state.pendingSwitch || state.queue.length)
    throw new Error('Wait for this chat to finish its current work before starting voice conversation.');
  let chats = writers.get(controller);
  if (!chats) writers.set(controller, (chats = new Map()));
  let sessions = byAdapter.get(codex);
  if (!sessions) {
    byAdapter.set(codex, (sessions = new Set()));
    codex.serverObservers.add((/** @type {any} */ event) => observeVoice(codex, event));
  }
  let closed;
  const closure = new Promise((resolve) => {
    closed = resolve;
  });
  const writer = { controller, chatId, threadId: ref.key, codex, closure, closed, cancelled: false };
  chats.set(chatId, writer);
  sessions.add(writer);
  codex.pin(ref.key, true);
  try {
    try {
      // the Codex turns a voice session delegates run on the thread's own settings: the chat's permission goes on first
      // (electron/harness/codexRunPermission.cjs applyPermission), on the thread loaded for writing
      await codex.ensureResumed(ref.key);
      await codex.applyPermission(chatId, ref.key);
    } catch (error) {
      throw Object.assign(error, { voiceNotDispatched: true });
    }
    const unguard = guardSend(params, () => {
      if (!current() || writer.cancelled) throw Object.assign(new Error('Native voice start was cancelled'), { voiceNotDispatched: true });
    });
    const sending = codex.request('thread/realtime/start', params);
    void sending.then(unguard, unguard);
    return await voiceDeadline(sending, timeoutMs);
  } catch (error) {
    // A timed-out start may have reached the server. Only an explicit RPC refusal is definitive.
    if (error?.voiceNotDispatched || [-32600, -32601, -32602].includes(error?.code)) releaseVoice(writer);
    else void stopVoice(codex, ref.key).catch(ignoring('close an uncertain native voice start'));
    throw error;
  }
}

function releaseVoice(writer) {
  if (voiceWriter(writer.controller, writer.chatId) !== writer) return;
  writers.get(writer.controller).delete(writer.chatId);
  byAdapter.get(writer.codex).delete(writer);
  writer.cancelled = true;
  writer.closed();
  writer.codex.pin(writer.threadId, false);
  const state = writer.controller.state.get(writer.chatId);
  writer.controller.state.patch(writer.chatId, {
    queue: state.queue.map((q) => {
      if (q.waitingFor !== 'voiceConversation') return q;
      const { waitingFor: _waiting, ...ready } = q;
      return ready;
    }),
  });
  writer.controller.drain(writer.chatId)?.catch(ignoring('send retained input after voice closes'));
}

async function stopVoice(codex, threadId, timeoutMs = 10_000) {
  const writer = [...(byAdapter.get(codex) ?? [])].find((w) => w.threadId === threadId);
  if (!writer) return;
  writer.cancelled = true;
  writer.stopping ??= codex.request('thread/realtime/stop', { threadId }).catch((error) => {
    writer.stopping = null;
    throw error;
  });
  await voiceDeadline(writer.stopping, timeoutMs);
  await voiceDeadline(writer.closure, timeoutMs);
}

/** The adapter owns server closure, including renderer loss and process exit; startVoice registers this once it holds the adapter's sessions. */
function observeVoice(codex, event) {
  for (const writer of [...byAdapter.get(codex)])
    if (event.kind !== 'message' || (event.msg?.method === 'thread/realtime/closed' && event.msg.params?.threadId === writer.threadId))
      releaseVoice(writer);
}

module.exports = { startVoice, stopVoice, observeVoice, voiceWriter };
