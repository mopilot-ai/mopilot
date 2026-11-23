// Remote send identity and canonical payload fingerprints shared by ordinary chats and MoMo, over the one transport ledger.
const { SendLedger } = require('./sendLedger.cjs');
const { identityKey } = require('../../shared/identityKey.mjs');
const MEMORY = new WeakMap();

function ledgerOf(/** @type {any} */ svc) {
  if (svc.transport?.sendLedger) return svc.transport.sendLedger;
  if (!MEMORY.has(svc)) MEMORY.set(svc, new SendLedger());
  return MEMORY.get(svc);
}

/** Record keys are irrelevant; array order and every normalized delivery-affecting field remain significant. @returns {any} */
function canonical(/** @type {any} */ value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((k) => [k, canonical(value[k])]),
    );
  return value;
}

const payloadOf = (/** @type {any} */ value) => JSON.stringify(canonical(value));
const sendKey = (/** @type {any} */ client, /** @type {string} */ method, /** @type {string} */ chatId, /** @type {string} */ id) =>
  identityKey(client.kind, client.kind === 'phone' ? client.pairId : null, method, chatId, id);

module.exports = { ledgerOf, payloadOf, sendKey };
