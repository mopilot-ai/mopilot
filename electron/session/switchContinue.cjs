// A chat that came back to this Mac from another Host (docs: design/host/index.html, package 3.1): its next message opens a new native session in the folder the user picked, with the handoff the other Host recorded in front of it. The same settling a harness switch does (switch.cjs), without choosing a harness or composing a record: both arrive with the continue.
const { estimateTokens } = require('../../shared/handoff.mjs');
const { messageOf } = require('../ignored.cjs');
const { segmentKey } = require('../platform/segmentOwner.cjs');
const { noteIgnored } = require('../ignored.cjs');
const { switchedConfig } = require('./keepSelection.cjs');
const { captureContinueModel } = require('./continueModel.cjs');

/** The divider the chat shows where it came back. */
const DIVIDER = 'Continued on this Mac';

/**
 * @param {any} r the SwitchRunner
 * @param {string} chatId
 * @param {{ harness: string, cwd: string, text: string }} c what the continue left for the chat
 * @param {unknown} origin
 * @param {string[]} claimed native sessions claimed for the chat while it settles; the caller drops the claims
 * @param {() => void} check assert the triggering input still owns this continuation after each wait
 * @returns {Promise<{ ready: boolean, error?: string, prefix?: string, note?: object }>}
 */
async function performContinue(r, chatId, c, origin, claimed, check) {
  // the segment the chat is leaving, read before the new one is committed
  const before = r.ref(chatId);
  let model;
  try {
    model = captureContinueModel(r, chatId, c, before);
  } catch (e) {
    return { ready: false, error: `${messageOf(e)} Your message is kept in the queue.` };
  }
  const { segs, turns } = await r.chatTurns(chatId, before);
  check();
  const n = turns.length;
  const cur = segs[segs.length - 1];
  cur.count = n - cur.start;
  let prepared;
  try {
    prepared = await r.startNative(chatId, c.harness, c.cwd, model, claimed);
  } catch (e) {
    check();
    const why = `Couldn't start ${r.label(c.harness)}: ${messageOf(e)}`;
    r.toast('error', why, origin);
    return { ready: false, error: `${why}. Your message is kept in the queue: fix that and send it again.` };
  }
  check();
  segs.push({
    kind: c.harness,
    nativeId: prepared.nativeId,
    instance: null,
    provider: null,
    model,
    start: n,
    count: null,
    handoff: { mode: 'continue', tokens: estimateTokens(c.text), text: c.text },
  });
  // what changed in the chat meanwhile (a pin, a project, notes) stays
  const now = r.chats.record(chatId);
  const config = switchedConfig(now.meta?.config, model, before.kind === c.harness ? now.meta?.config : null);
  const saved = r.chats.commit({ ...now, meta: { ...now.meta, config, continueModel: null }, segments: segs });
  if (!saved) return { ready: false, error: 'The chat could not save its new session. Your message is kept in the queue.' };
  r.invalidate();
  try {
    await r.putAccount?.({ chatId, harness: c.harness, nativeId: prepared.nativeId, account: null });
  } catch (e) {
    r.toast('error', `Couldn't put this chat on its ${r.label(c.harness)} account (${messageOf(e)}); it uses the one in use`, origin);
  }
  try {
    r.segmentEnded?.({ chatId, from: before, to: r.ref(chatId) });
  } catch (error) {
    noteIgnored("retire a chat's earlier segment after a continue", error);
  }
  r.changed(chatId);
  r.emit(
    {
      kind: 'switched',
      chatId,
      harness: c.harness,
      key: segmentKey(c.harness, prepared.nativeId),
      model,
      fresh: !!prepared.fresh,
      start: n,
    },
    'any',
  );
  return { ready: true, prefix: c.text, note: { kind: 'switch', text: DIVIDER, handoff: c.text } };
}

module.exports = { performContinue };
