// The words Global Auto compares a request with HM-Router's benchmark queries by: lowercase Latin words and numbers of two
// or more characters, and each CJK character, shared by the table build (scripts/build-hm-table.mjs) and the scorer.
const STOP = new Set(
  'the and for you are with that this your from have will can not but all any use using into each then than when what which should must'.split(
    ' ',
  ),
);

/** @param {string} text @returns {string[]} */
function termsOf(text) {
  const out = [];
  for (const m of String(text ?? '')
    .toLowerCase()
    .matchAll(/[a-z][a-z0-9_]+|\p{Script=Han}/gu)) {
    if (!STOP.has(m[0])) out.push(m[0]);
  }
  return out;
}

module.exports = { termsOf };
