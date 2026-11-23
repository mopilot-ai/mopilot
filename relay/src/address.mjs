// Where a request came from: the socket's address, or, behind a proxy the relay trusts (TRUST_PROXY=1, only when it sits behind
// Caddy), the last address that proxy appended to X-Forwarded-For. Add by command shows it to the user before Allow, and the Host
// credential limits are kept per address, so behind a proxy the socket's own address would be the proxy's for everyone.

/** @param {import('node:http').IncomingMessage} req @param {boolean | undefined} trustProxy */
export function clientAddress(req, trustProxy) {
  const hops = trustProxy
    ? String(req.headers['x-forwarded-for'] ?? '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
    : [];
  return hops.at(-1) ?? String(req.socket.remoteAddress);
}
