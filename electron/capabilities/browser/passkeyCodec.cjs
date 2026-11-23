// Runs in a built-in browser page, next to the navigator.credentials wrapper (passkeys.cjs): turns WebAuthn options into
// JSON for the passkey bridge (bytes as { b64u }) and the bridge's answer back into a PublicKeyCredential, shaped as
// password-manager extensions build theirs (the real prototypes, with own fields and methods, and toJSON).

/**
 * Serialized with Function.prototype.toString into the page, so it must not close over anything.
 * @param {any} G the page's globalThis
 */
function passkeyCodec(G) {
  const toB64u = (/** @type {Uint8Array} */ u8) => {
    let s = '';
    for (let i = 0; i < u8.length; i += 0x8000) s += G.String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
    return G.btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  };
  const fromB64u = (/** @type {string} */ s) => {
    const bin = G.atob(s.replace(/-/g, '+').replace(/_/g, '/'));
    const u8 = new G.Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
    return u8.buffer;
  };
  /** JSON-safe copy of WebAuthn options: bytes become { b64u }, functions and deep nesting go. */
  const encode = (/** @type {any} */ v, depth = 0) => {
    if (typeof v === 'function' || (depth > 6 && v !== null && typeof v === 'object')) return undefined;
    if (v === null || typeof v !== 'object') return v;
    if (v instanceof G.ArrayBuffer) return { b64u: toB64u(new G.Uint8Array(v)) };
    if (G.ArrayBuffer.isView(v)) return { b64u: toB64u(new G.Uint8Array(v.buffer, v.byteOffset, v.byteLength)) };
    if (G.Array.isArray(v)) return v.slice(0, 256).map((x) => encode(x, depth + 1));
    const out = {};
    for (const k of G.Object.keys(v).slice(0, 64)) if (k !== 'signal') out[k] = encode(v[k], depth + 1);
    return out;
  };
  /** Own, read-only fields on an object of `proto` (so instanceof holds and the prototype's getters are shadowed). */
  const make = (/** @type {any} */ proto, /** @type {Record<string, unknown>} */ fields) => {
    const o = G.Object.create(proto ?? G.Object.prototype);
    for (const [k, value] of G.Object.entries(fields)) G.Object.defineProperty(o, k, { value, enumerable: typeof value !== 'function' });
    return o;
  };
  /** The PublicKeyCredential for the bridge's answer (passkeyResult.cjs pageAnswer). */
  const toCredential = (/** @type {any} */ c) => {
    const r = c.response;
    const created = typeof r.attestationObject === 'string';
    const transports = G.Array.isArray(r.transports) ? r.transports.slice() : [];
    const json = {
      clientDataJSON: r.clientDataJSON,
      ...(created
        ? {
            attestationObject: r.attestationObject,
            authenticatorData: r.authenticatorData,
            transports,
            publicKey: r.publicKey,
            publicKeyAlgorithm: r.publicKeyAlgorithm,
          }
        : { authenticatorData: r.authenticatorData, signature: r.signature, userHandle: r.userHandle ?? null }),
    };
    const response = created
      ? make(G.AuthenticatorAttestationResponse?.prototype, {
          clientDataJSON: fromB64u(r.clientDataJSON),
          attestationObject: fromB64u(r.attestationObject),
          getTransports: () => transports.slice(),
          getAuthenticatorData: () => fromB64u(r.authenticatorData),
          getPublicKey: () => (r.publicKey ? fromB64u(r.publicKey) : null),
          getPublicKeyAlgorithm: () => r.publicKeyAlgorithm,
        })
      : make(G.AuthenticatorAssertionResponse?.prototype, {
          clientDataJSON: fromB64u(r.clientDataJSON),
          authenticatorData: fromB64u(r.authenticatorData),
          signature: fromB64u(r.signature),
          userHandle: r.userHandle ? fromB64u(r.userHandle) : null,
        });
    return make(G.PublicKeyCredential?.prototype, {
      id: c.id,
      rawId: fromB64u(c.id),
      type: 'public-key',
      authenticatorAttachment: c.authenticatorAttachment,
      response,
      getClientExtensionResults: () => ({}),
      toJSON: () => ({
        id: c.id,
        rawId: c.id,
        type: 'public-key',
        authenticatorAttachment: c.authenticatorAttachment,
        response: { ...json },
        clientExtensionResults: {},
      }),
    });
  };
  return { encode, toCredential };
}

module.exports = { passkeyCodec };
