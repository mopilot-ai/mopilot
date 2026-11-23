// Parses an XML property list (what `plutil -convert xml1` prints) into plain values, including the data and date values JSON cannot hold.
const { ImportError } = require('./errors.cjs');

const TAG = /<\?[\s\S]*?\?>|<!--[\s\S]*?-->|<!DOCTYPE[^>]*>|<(\/?)([A-Za-z]+)[^>]*?(\/?)>/g;
const ENTITY = /&(?:#x([0-9a-fA-F]+)|#(\d+)|(amp|lt|gt|quot|apos));/g;
const NAMED = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
const LEAVES = new Set(['key', 'string', 'integer', 'real', 'date', 'data']);

const bad = (why) => new ImportError('read_failed', `The property list could not be parsed (${why}).`);

/** @param {string} text */
function decode(text) {
  return text.replace(ENTITY, (_, hex, dec, name) => {
    if (name) return NAMED[/** @type {keyof typeof NAMED} */ (name)];
    const code = hex ? parseInt(hex, 16) : Number(dec);
    if (code > 0x10ffff) throw bad(`an invalid character reference &#${hex ? `x${hex}` : dec};`);
    return String.fromCodePoint(code);
  });
}

/**
 * A leaf element's value: data is a Buffer, a date is milliseconds since the Unix epoch (null when unreadable).
 * @param {string} name
 * @param {string} text
 */
function leafValue(name, text) {
  if (name === 'integer' || name === 'real') return Number(text.trim());
  if (name === 'data') return Buffer.from(text.replace(/\s+/g, ''), 'base64');
  if (name === 'date') {
    const ms = Date.parse(text.trim());
    return Number.isNaN(ms) ? null : ms;
  }
  return decode(text);
}

/**
 * The root value of an XML property list. Dictionaries have no prototype, so a key such as `__proto__` is an
 * ordinary entry. A malformed document throws an ImportError('read_failed').
 * @param {string} xml
 * @returns {unknown}
 */
function parsePlistXml(xml) {
  /** @type {{ name: string, value: any, key: string | null }[]} */
  const stack = [];
  /** @type {{ value: unknown } | null} */
  let root = null;
  /** @type {{ name: string, start: number } | null} */
  let leaf = null;
  const put = (/** @type {unknown} */ value) => {
    const top = stack.at(-1);
    if (!top) throw bad('a value outside the document');
    if (top.name === 'array') top.value.push(value);
    else if (top.name === 'dict') {
      if (top.key === null) throw bad('a value without a key');
      top.value[top.key] = value;
      top.key = null;
    } else if (top.value === undefined) top.value = value;
    else throw bad('more than one root value');
  };
  const leafDone = (/** @type {string} */ name, /** @type {string} */ text) => {
    const top = stack.at(-1);
    if (name !== 'key') put(leafValue(name, text));
    else if (top?.name === 'dict' && top.key === null) top.key = decode(text);
    else throw bad('a key outside a dictionary');
  };
  TAG.lastIndex = 0;
  for (let m = TAG.exec(xml); m; m = TAG.exec(xml)) {
    const [, close, name, self] = m;
    if (!name) continue;
    if (leaf) {
      if (!close || name !== leaf.name) throw bad(`<${name}> inside <${leaf.name}>`);
      leafDone(name, xml.slice(leaf.start, m.index));
      leaf = null;
    } else if (close) {
      const top = stack.pop();
      if (top?.name !== name) throw bad(`an unmatched </${name}>`);
      if (top.key !== null) throw bad('a key without a value');
      if (name === 'plist') root = { value: top.value };
      else put(top.value);
    } else if (name === 'true' || name === 'false') {
      put(name === 'true');
    } else if (LEAVES.has(name)) {
      if (self) leafDone(name, '');
      else leaf = { name, start: TAG.lastIndex };
    } else if (name === 'plist' || name === 'dict' || name === 'array') {
      const value = name === 'dict' ? Object.create(null) : name === 'array' ? [] : undefined;
      if (self) put(value);
      else stack.push({ name, value, key: null });
    } else {
      throw bad(`an unknown <${name}>`);
    }
  }
  if (!root || stack.length || leaf) throw bad('an incomplete document');
  return root.value;
}

module.exports = { parsePlistXml };
