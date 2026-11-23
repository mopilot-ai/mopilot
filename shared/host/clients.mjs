// The Host's client table on the wire: the `clients` feature's four methods (`host.clients`, `host.clientAdd`, `host.clientRemove`, `host.clientRename`), their parameter parsers and the parser of the list a client reads back.
import { SchemaError } from '../remote/schema.mjs';

export const CLIENTS_FEATURE = 'clients';
export const CLIENT_METHODS = Object.freeze(['host.clients', 'host.clientAdd', 'host.clientRemove', 'host.clientRename']);
export const CLIENT_KINDS = Object.freeze(['desktop', 'phone', 'cli']);
export const NAME_MAX = 80;
const bad = (/** @type {string} */ message) => new SchemaError(message);
const FINGERPRINT = /^[0-9a-f]{64}$/;

/** A name a person gave a device, as stored: control characters and line breaks turned to spaces, trimmed, bounded. A name is a label, so an odd one is cleaned, never refused. @param {unknown} v */
export const clientNameOf = (v) =>
  typeof v === 'string'
    ? v
        // eslint-disable-next-line no-control-regex
        .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, ' ')
        .trim()
        .slice(0, NAME_MAX)
    : '';

/** The optional `name` of a request: absent, or text. @param {any} p */
export function optionalName(p) {
  if (p.name == null) return {};
  if (typeof p.name !== 'string') throw bad('That device name is not text.');
  return { name: clientNameOf(p.name) };
}

export const clientParsers = () => ({
  'host.clients': () => ({}),
  'host.clientAdd': (/** @type {any} */ p) => {
    if (typeof p.publicKey !== 'string' || !p.publicKey || p.publicKey.length > 200) throw bad('That client has no valid publicKey.');
    if (!CLIENT_KINDS.includes(p.kind)) throw bad('That client kind is not one this Host knows.');
    return { publicKey: p.publicKey, kind: p.kind, name: clientNameOf(p.name) };
  },
  'host.clientRemove': (/** @type {any} */ p) => {
    if (typeof p.fingerprint !== 'string' || !FINGERPRINT.test(p.fingerprint)) throw bad('That client fingerprint is not valid.');
    return { fingerprint: p.fingerprint };
  },
  'host.clientRename': (/** @type {any} */ p) => {
    if (typeof p.name !== 'string') throw bad('That device name is not text.');
    return { name: clientNameOf(p.name) };
  },
});

/**
 * The `host.clients` answer as a client reads it: a record it cannot read is left out, never guessed at.
 * @param {unknown} result
 * @returns {{ fingerprint: string, name: string, kind: string, addedAt: number, addedBy: string, connected: boolean }[]}
 */
export function clientListOf(result) {
  const list = /** @type {any} */ (result)?.clients;
  if (!Array.isArray(list)) return [];
  return list
    .filter((c) => c && typeof c.fingerprint === 'string' && FINGERPRINT.test(c.fingerprint) && CLIENT_KINDS.includes(c.kind))
    .map((c) => ({
      fingerprint: c.fingerprint,
      name: clientNameOf(c.name),
      kind: c.kind,
      addedAt: Number.isFinite(c.addedAt) ? c.addedAt : 0,
      addedBy: typeof c.addedBy === 'string' ? c.addedBy.slice(0, 200) : '',
      connected: c.connected === true,
    }));
}
