// The dev host address a development build may talk to instead of MoPilot's servers: a plain-http origin on this machine or its local network (scripts/mobile-dev-host.mjs). Nothing sets it in a production build.
const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/;
const PRIVATE = [/^10\./, /^192\.168\./, /^172\.(1[6-9]|2\d|3[01])\./];

/** Whether the host is one a dev build may reach in the clear: loopback, a private IPv4 or a .local name. */
function isLocalHost(/** @type {string} */ host) {
  // the private ranges are matched on a whole dotted address: 192.168.1.1.example.com is a public name
  return host === 'localhost' || host === '127.0.0.1' || host.endsWith('.local') || (IPV4.test(host) && PRIVATE.some((re) => re.test(host)));
}

/**
 * @param {unknown} value for example http://192.168.1.20:8787
 * @returns {{ origin: string, relayUrl: string } | null} null when it is not a bare http origin on a local host
 */
function parseDevHost(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  let url;
  try {
    url = new URL(value.trim());
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' || url.username || url.password || url.search || url.hash || url.pathname !== '/') return null;
  if (!isLocalHost(url.hostname)) return null;
  return { origin: url.origin, relayUrl: `ws://${url.host}/v1/ws` };
}

/** The build's dev host from MOPILOT_DEV_HOST: none when unset, an error naming the variable when set to anything else. @param {Record<string, string | undefined>} env */
function devHostFromEnv(env) {
  const value = env.MOPILOT_DEV_HOST;
  if (value === undefined || value.trim() === '') return null;
  const parsed = parseDevHost(value);
  if (!parsed) throw new Error(`MOPILOT_DEV_HOST must be an http://<local address>:<port> origin (a private IP, localhost or a .local name), got "${value}"`);
  return parsed;
}

module.exports = { isLocalHost, parseDevHost, devHostFromEnv };
