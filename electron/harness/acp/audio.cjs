// ACP audio delivery separates definitive provider responses from transport ambiguity and reconstructs interrupted history.
const { endWhy } = require('./providerErrors.cjs');
const { UNKNOWN_AUDIO } = require('../../platform/audioDispatch.cjs');
const { noteIgnored } = require('../../ignored.cjs');

function audioEnd(host, chat, run, reason, error) {
  if (!run.audio) return endWhy(run, reason, error);
  const unknown = !run.audioResponse;
  const detail = error ?? run.providerError;
  const why = unknown
    ? { ...endWhy(run, reason, error), error: detail ? `${UNKNOWN_AUDIO} ${detail}` : UNKNOWN_AUDIO, delivery: 'unknown' }
    : { ...endWhy(run, reason, error), delivery: 'confirmed' };
  try {
    host.audioDispatch.settle(run.audioIntent, unknown ? 'unknown' : 'confirmed', why.error, reason);
  } catch (e) {
    noteIgnored('save audio delivery outcome; the durable intent remains unresolved', e);
  }
  return why;
}

/** The records each audio dispatch of a chat stands for, which its transcript may lack: an interrupted one wrote none. */
function audioRecords(host, key) {
  /** @type {any[]} */
  const records = [];
  for (const r of host.audioDispatch?.list(key) ?? []) {
    const turnId = `at-${r.clientId}`;
    records.push({ t: 'user', turnId, user: { id: `u-${r.clientId}`, clientId: r.clientId, content: r.display }, at: r.at });
    if (host.chats.get(key)?.prompting?.turnId !== turnId)
      records.push({
        t: 'end',
        turnId,
        stopReason: r.stopReason ?? 'error',
        error: r.state === 'confirmed' ? (r.error ?? null) : (r.error ?? UNKNOWN_AUDIO),
        delivery: r.state === 'confirmed' ? 'confirmed' : 'unknown',
        at: r.at,
      });
  }
  return records;
}

async function audioHistory(host, key) {
  const records = await host.items.readAsync(key);
  for (const r of audioRecords(host, key)) if (!records.some((v) => v.t === r.t && v.turnId === r.turnId)) records.push(r);
  return records;
}

/** Where the core reads a chat's transcript, every line of it written by now, and what main adds to it (AcpItems.history). */
async function historySource(host, key) {
  await host.items.flush(key);
  return { file: host.items.file(key), extra: audioRecords(host, key) };
}

module.exports = { audioEnd, audioHistory, historySource };
