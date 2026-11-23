// The two request fields that carry a git sign-in on the Host wire: the credential one clone borrows (`git.clone`) and the repository hosts a status reports on (`host.status`). Shared by the app and the Host with the rest of the parsers (./schema.mjs).
import { SchemaError } from '../remote/schema.mjs';

const bad = (/** @type {string} */ message) => new SchemaError(message);

/** The sign-in one clone borrows: a user name and a secret for an https address only (ssh keys are never lent), bounded, no control byte. @param {unknown} v @param {unknown} url */
export function cloneCredentialOf(v, url) {
  const c = /** @type {any} */ (v);
  const line = (/** @type {unknown} */ x) => typeof x === 'string' && x.length > 0 && x.length <= 2048 && !/[\u0000-\u001f\u007f]/.test(x);
  if (typeof url !== 'string' || !url.startsWith('https://') || !c || typeof c !== 'object' || !line(c.username) || !line(c.password))
    throw bad('That sign-in cannot be used for this clone.');
  return { username: c.username, password: c.password };
}
/** The repository hosts a status asks about: a few plain host names, each with an optional port. @param {unknown} v */
export function signInHostsOf(v) {
  const ok =
    Array.isArray(v) &&
    v.length > 0 &&
    v.length <= 4 &&
    v.every((h) => typeof h === 'string' && /^[A-Za-z0-9](?:[A-Za-z0-9.-]{0,251}[A-Za-z0-9])?(?::\d{1,5})?$/.test(h));
  if (!ok) throw bad('Name the repository hosts to check.');
  return [...new Set(/** @type {string[]} */ (v))];
}
