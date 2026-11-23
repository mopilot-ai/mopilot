// Which strings may name a Tart VM or an image to clone (G8 #3903): `tart` resolves a name by joining it onto its VM directory, so a name with a path separator or `..` addresses another VM's directory ("x/../mopilot-bench" is the bench VM). Every name that reaches `tart` passes this first.

const MAX_NAME = 64;
const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
/** One path segment of an image reference: a registry host (with an optional port) or a repository component. */
const SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const HOST_PORT = /^[A-Za-z0-9][A-Za-z0-9._-]*(:[0-9]{1,5})?$/;
const TAG = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/;
const DIGEST = /^[A-Za-z][A-Za-z0-9]*:[A-Fa-f0-9]{32,}$/;

/** Whether `name` is a plain VM name: letters, digits, dot, underscore and dash, starting with a letter or digit, no `..`, at most 64 characters. @param {unknown} name */
export function isVmName(name) {
  return typeof name === 'string' && name.length <= MAX_NAME && NAME.test(name) && !name.includes('..');
}

/** Whether `ref` is a plain VM name or an OCI image reference (`registry[:port]/path[:tag|@digest]`) whose every part is plain: no empty or dot-dot component, no leading dash. @param {unknown} ref */
export function isImageRef(ref) {
  if (isVmName(ref)) return true;
  if (typeof ref !== 'string' || ref.length === 0 || ref.length > 255 || ref.includes('..')) return false;
  const at = ref.indexOf('@');
  const base = at === -1 ? ref : ref.slice(0, at);
  const digest = at === -1 ? null : ref.slice(at + 1);
  if (digest !== null && !DIGEST.test(digest)) return false;
  const parts = base.split('/');
  if (parts.length < 2 || parts.some((p) => p === '')) return false;
  const last = parts.length - 1;
  const [name, tag, ...extra] = parts[last].split(':');
  if (extra.length > 0 || (tag !== undefined && (!TAG.test(tag) || digest !== null))) return false;
  return HOST_PORT.test(parts[0]) && parts.slice(1, last).every((p) => SEGMENT.test(p)) && SEGMENT.test(name);
}

/** Throws unless `name` is a plain VM name. @param {unknown} name @returns {string} */
export function assertVmName(name) {
  if (!isVmName(name)) throw new Error(`${JSON.stringify(name)} is not a valid VM name.`);
  return /** @type {string} */ (name);
}

/** Throws unless `ref` is a plain VM name or an image reference. @param {unknown} ref @returns {string} */
export function assertImageRef(ref) {
  if (!isImageRef(ref)) throw new Error(`${JSON.stringify(ref)} is not a valid image reference.`);
  return /** @type {string} */ (ref);
}
