// Closed shadow roots for the browser tools (#3571, G9), main's half: the page agent can't see a closed root, CDP can.
// After a read the agent flags (closedRoots), main finds the closed root of each host it offers (DOM.describeNode with
// pierce), hands it to the agent's world (adopt) and runs the read once more. Every route that drives a page through
// a browser host tab gets it: the in-app browser, the user's Chrome over MoPilot's extension, and a Host's Chromium.
const { noteIgnored } = require('../../ignored.cjs');

/** Page agent ops that only read, so running one again after the hand-over changes nothing on the page. */
const RESCAN_OPS = new Set(['tree', 'find', 'text', 'query', 'inspect', 'state', 'intent', 'mask', 'credentialFields']);
/** Hosts asked about per read: a page full of custom elements is covered over a few reads, never in one long stall. */
const HOSTS_PER_READ = 200;
const GROUP = 'mopilot-closed-shadow';

/**
 * Hands the closed shadow roots of the hosts the page agent offers to its world.
 * @param {{ send: (method: string, params?: object, sessionId?: string) => Promise<any> }} tab
 * @param {number} contextId the agent's execution context
 * @param {string} sessionId
 * @returns {Promise<boolean>} whether any root was handed over
 */
async function adoptClosedRoots(tab, contextId, sessionId) {
  try {
    const list = await tab.send(
      'Runtime.evaluate',
      { expression: `globalThis.__mopilotAgent.closedHosts(${HOSTS_PER_READ})`, contextId, objectGroup: GROUP },
      sessionId,
    );
    const arrayId = list?.result?.objectId;
    if (!arrayId) return false;
    const { result = [] } = (await tab.send('Runtime.getProperties', { objectId: arrayId, ownProperties: true }, sessionId)) || {};
    const hosts = result.filter((p) => /^\d+$/.test(p.name) && p.value?.objectId).map((p) => p.value.objectId);
    const adopted = await Promise.all(hosts.map((objectId) => adoptOne(tab, objectId, contextId, sessionId)));
    return adopted.includes(true);
  } finally {
    await tab.send('Runtime.releaseObjectGroup', { objectGroup: GROUP }, sessionId).catch((error) =>
      // the page may have gone: its objects went with it
      noteIgnored('let go of the hosts read for closed shadow roots', error),
    );
  }
}

/** One host: its closed root, if it has one, resolved in the agent's world and handed over. */
async function adoptOne(tab, objectId, contextId, sessionId) {
  try {
    const { node } = await tab.send('DOM.describeNode', { objectId, depth: 1, pierce: true }, sessionId);
    const root = (node?.shadowRoots || []).find((s) => s.shadowRootType === 'closed');
    if (!root) return false;
    const { object } = await tab.send(
      'DOM.resolveNode',
      { backendNodeId: root.backendNodeId, executionContextId: contextId, objectGroup: GROUP },
      sessionId,
    );
    const r = await tab.send(
      'Runtime.callFunctionOn',
      {
        objectId,
        functionDeclaration: 'function (root) { return globalThis.__mopilotAgent.adopt(this, root); }',
        arguments: [{ objectId: object.objectId }],
        returnByValue: true,
      },
      sessionId,
    );
    return r?.result?.value === true;
  } catch (error) {
    // a host that left the page meanwhile: the next read offers whatever is there then
    noteIgnored('hand a closed shadow root to the page agent', error);
    return false;
  }
}

/**
 * Runs a page agent op (`once` evaluates it and returns the raw Runtime.evaluate reply); when it flagged hosts that may
 * hold closed roots and the op only reads, hands the roots over and runs it once more.
 * @param {{ send: (method: string, params?: object, sessionId?: string) => Promise<any> }} tab
 * @param {string} op
 * @param {number} contextId
 * @param {string} sessionId
 * @param {(again: boolean) => Promise<any>} once
 */
async function readThroughClosedRoots(tab, op, contextId, sessionId, once) {
  const r = await once(false);
  if (!r?.result?.value?.closedRoots || !RESCAN_OPS.has(op)) return r;
  let adopted = false;
  try {
    adopted = await adoptClosedRoots(tab, contextId, sessionId);
  } catch (error) {
    // the hand-over only adds to a read that already worked: the read stands, and the next one offers the hosts again
    noteIgnored('read closed shadow roots for the page agent', error);
  }
  return adopted ? once(true) : r;
}

module.exports = { adoptClosedRoots, readThroughClosedRoots, RESCAN_OPS, HOSTS_PER_READ };
