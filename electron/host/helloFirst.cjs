// The handshake every request of the versioned protocol (host.*, chat.*, browser.*, desktop.*) needs first on its connection: `host.hello`, then what both ends agreed checked against what the request needs. Methods the Host serves before the protocol (git.status, fs.*) need none.
const { helloParams, negotiate, parseParams, requireFeatures } = require('../../shared/host/schema.mjs');

/**
 * Says hello on `s` and checks the agreed features cover `method`; throws the Host's own refusal (`feature_missing`, `Unknown method …`) when they do not.
 * @param {{ call: (method: string, params?: object, opts?: { timeoutMs?: number }) => Promise<any> }} s an open authenticated connection
 * @param {string} [method] the request that follows (none: any Host will do)
 * @returns {Promise<{ features: string[] }>} what both ends agreed
 */
async function sayHello(s, method) {
  const reply = await s.call('host.hello', { ...helloParams(), moved: [] });
  const agreed = negotiate(helloParams(), parseParams('host.hello', reply));
  if (method) requireFeatures(method, agreed);
  return agreed;
}

module.exports = { sayHello };
