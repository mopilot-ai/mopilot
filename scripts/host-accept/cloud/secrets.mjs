// The provider key of a cloud acceptance run: `config.json` (identifiers, none a secret) and the private key it names, read from one directory on this Mac. Only a signer and the identifiers leave this file: the key is never returned, printed or put in an error.
import nodeFs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

/** The identifiers the OCI adapter needs; `keyFile` names the private key. */
const FIELDS = ['tenancy', 'user', 'fingerprint', 'region', 'compartmentId', 'subnetId'];

/** @param {string} p @param {string} home */
const expand = (p, home) => (p === '~' || p.startsWith('~/') ? path.join(home, p.slice(1)) : p);

/**
 * @param {string} dir the secrets directory (`~` allowed)
 * @param {{ fs?: Pick<typeof nodeFs, 'readFileSync' | 'statSync'>, home?: string }} [o]
 * @returns {{ config: { tenancy: string, user: string, fingerprint: string, region: string, compartmentId: string, subnetId: string }, sign: (text: string) => string }}
 */
export function readOciSecrets(dir, { fs = nodeFs, home = os.homedir() } = {}) {
  const base = expand(dir, home);
  /** @type {any} */
  let doc;
  try {
    doc = JSON.parse(String(fs.readFileSync(path.join(base, 'config.json'), 'utf8')));
  } catch {
    // a parse error can quote the text, so it is not passed on
    throw new Error(`${path.join(base, 'config.json')} is missing or is not JSON.`);
  }
  for (const f of FIELDS) if (typeof doc?.[f] !== 'string' || !doc[f].trim()) throw new Error(`config.json has no ${f}.`);
  const keyFile = typeof doc.keyFile === 'string' && doc.keyFile ? expand(doc.keyFile, home) : path.join(base, 'key.pem');
  let mode;
  try {
    mode = fs.statSync(keyFile).mode;
  } catch {
    throw new Error(`The private key ${keyFile} is missing.`);
  }
  if (mode & 0o077) throw new Error(`The private key ${keyFile} can be read by others: chmod 600 it.`);
  // the OCI console appends a marker line (`OCI_API_KEY`) after the END line: only the PEM block is kept
  const pem = String(fs.readFileSync(keyFile, 'utf8')).match(
    /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]+?-----END [A-Z ]*PRIVATE KEY-----/,
  )?.[0];
  if (!pem) throw new Error(`${keyFile} is not a PEM private key.`);
  const { ociSigner } = require('../../../electron/host/cloudService.cjs');
  return { config: /** @type {any} */ (Object.fromEntries(FIELDS.map((f) => [f, doc[f].trim()]))), sign: ociSigner(pem) };
}
