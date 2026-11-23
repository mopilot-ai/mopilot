// This Mac as a Host for a continue, in both directions (docs: design/host/index.html, package 3.1): the same continue Host a remote Host runs, over this Mac's own epoch file, ledger and owner file, answering the app's channel for 'local'. As a source it releases the chat; as a target it keeps the handoff in the inbox until the chat's next message opens its session (switchContinue.cjs).
const path = require('node:path');
const { randomBytes } = require('node:crypto');
const { createContinueHost } = require('../../host/src/continue.mjs');
const { createEpochStore } = require('../../host/src/epochs.mjs');
const { createLedger } = require('../../host/src/ledger.mjs');
const { createOwnerStore } = require('../../host/src/owners.mjs');
const schema = require('../../shared/host/schema.mjs');

/** A request this Mac does not answer. */
const refuse = () => {
  throw Object.assign(new Error('That is not a request this Mac answers.'), { code: 'unsupported' });
};

/**
 * @param {object} o
 * @param {string} o.dir where the epoch file, the ledger and the owner file live (under userData)
 * @param {ReturnType<typeof import('./continueInbox.cjs').createContinueInbox>['target']} o.target the target half: check the folder and agent, keep the handoff, bind it when the chat is this Mac's
 * @param {(chatId: string) => boolean} o.serves this Mac runs the chat
 * @param {(chatId: string) => boolean} o.busy a turn is running, or a message is queued or being sent, for the chat
 * @param {(chatId: string) => Promise<void>} o.retire stops what this Mac still runs for a chat that moved away
 * @param {(problem: string) => void} o.report
 */
function createLocalContinue({ dir, target, serves, busy, retire, report }) {
  const epochs = createEpochStore(path.join(dir, 'epochs.json'), { report });
  const continueHost = createContinueHost({
    epochs,
    ledger: createLedger(path.join(dir, 'ledger'), { report }),
    owners: createOwnerStore(path.join(dir, 'owners.json'), { report }),
    target,
    serves,
    busy,
    quiesce: () => undefined,
    retire,
    report,
    newId: () => randomBytes(12).toString('hex'),
  });
  return {
    continueHost,
    /** The app's channel to this Mac's Host: the requests a continue sends, parsed as a remote Host would parse them. */
    channel: {
      /** @param {string} method @param {object} params */
      async call(method, params) {
        const p = schema.parseParams(method, params);
        switch (method) {
          case 'chat.prepareContinue':
            return continueHost.prepare(p);
          case 'chat.commitContinue':
            return continueHost.commit(p);
          case 'chat.release':
            return continueHost.release(p);
          case 'chat.subscribe':
            // told the epoch it already holds, or a newer one
            epochs.admit(p.chatId, p.epoch);
            continueHost.touch(p.chatId, p.epoch);
            return { subscribed: true };
          default:
            return refuse();
        }
      },
    },
  };
}

module.exports = { createLocalContinue };
