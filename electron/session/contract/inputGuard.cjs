// Main-only input ownership guards, rechecked by every harness adapter immediately before native dispatch, and the
// stable client id an input main delivered keeps in the harness's transcript.
const crypto = require('node:crypto');
const guards = new WeakMap();
const readiness = new WeakMap();
const clientIds = new WeakMap();
/** item -> the checks its send attached (ChatController.stopGuard): each throws once that send was stopped */
const sendChecks = new WeakMap();
const OWNER = Symbol('mopilot.inputOwner');

/** Attach a live owner check without serializing functions into IPC, transcripts or native prompts. */
function guardInput(item, current) {
  guards.set(item, current);
  return () => guards.delete(item);
}

/**
 * Attach a check that throws (with the reason) once the send that attached it should no longer reach its harness, such
 * as a Stop pressed after the send began. Unlike guardInput it does not make the input an automatic one.
 */
function guardSend(item, check) {
  const owner = item[OWNER] ?? item;
  const checks = sendChecks.get(owner) ?? new Set();
  sendChecks.set(owner, checks.add(check));
  return () => {
    checks.delete(check);
    if (!checks.size && sendChecks.get(owner) === checks) sendChecks.delete(owner);
  };
}

function assertInputCurrent(item) {
  const owner = item[OWNER] ?? item;
  const current = guards.get(owner);
  if (current && !current()) throw new Error('This automatic input was paused because its chat or settings changed');
  for (const check of sendChecks.get(owner) ?? []) check();
}

/** Whether this operation brought a live send check, including after an adapter copies its input. */
const hasSendGuard = (item) => sendChecks.has(item[OWNER] ?? item);

/** External lease checks run after native setup waits. Callers recheck assertInputCurrent after awaiting, immediately before sending. */
function guardInputReady(item, check) {
  const owner = item[OWNER] ?? item;
  readiness.set(owner, check);
}
/** Ordinary inputs keep their synchronous send boundary; only externally fenced inputs need an extra await. */
const hasInputReadiness = (item) => readiness.has(item[OWNER] ?? item);
async function assertInputReady(item) {
  const owner = item[OWNER] ?? item;
  const check = readiness.get(owner);
  if (check) await check();
  assertInputCurrent(item);
}

/** Symbols survive internal object spreads while JSON and Electron IPC omit them entirely. */
function carryInputGuard(item, target) {
  if (clientIds.has(item) || guards.has(item) || sendChecks.has(item) || readiness.has(item) || item[OWNER])
    target[OWNER] = item[OWNER] ?? item;
  return target;
}

function inputIsGuarded(item) {
  return guards.has(item[OWNER] ?? item);
}

/**
 * The client id a harness gives the input: a peer message's id, or the id main gave a brief, wake-up or family message
 * (session/orchestration), so the windows can tell those apart from what the user typed; any other input a new one.
 * A Host also lends a trusted client id through identifyInput; windows cannot set this main-only WeakMap identity.
 */
function clientIdOf(item) {
  return (
    clientIds.get(item?.[OWNER] ?? item) ?? item?.peer?.messageId ?? item?.sideSession?.id ?? item?.authored?.id ?? crypto.randomUUID()
  );
}

function identifyInput(item, id) {
  clientIds.set(item[OWNER] ?? item, id);
}

module.exports = {
  identifyInput,
  guardInput,
  guardSend,
  hasSendGuard,
  guardInputReady,
  hasInputReadiness,
  assertInputReady,
  assertInputCurrent,
  carryInputGuard,
  inputIsGuarded,
  clientIdOf,
};
