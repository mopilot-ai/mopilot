// Fill a clipped subscribe snapshot from pinned read-only journal pages before exposing its cursor or releasing held live frames.
const { HISTORY_CHARS } = require('../../shared/host/history.mjs');
const { openFramer } = require('../platform/coreFraming.cjs');
const { HostError } = require('./interface.cjs');
const invalid = () => new HostError('invalid', 'The Host sent incomplete chat history. Reopen the chat to retry.');
async function fillHistory(hello, call, { maxChars = 64 * 1024 * 1024 } = {}) {
  if (!hello?.snapshot?.paged) return;
  const items = [];
  // the core frames the pages' lines (electron/platform/coreFraming.cjs), with no limit of its own: all of them are within
  // maxChars. A page can end inside a surrogate pair, whose first half waits for the next page so the bytes are the text's
  const framer = openFramer();
  let carry = '';
  /** Whether a line has begun that no newline has ended. */
  let open = false;
  /** @param {string} chunk */
  const take = (chunk) => {
    const text = carry + chunk;
    const last = text.charCodeAt(text.length - 1);
    const cut = last >= 0xd800 && last <= 0xdbff ? text.length - 1 : text.length;
    carry = text.slice(cut);
    if (!text.length) return;
    open = !text.endsWith('\n');
    const framed = framer.push(Buffer.from(text.slice(0, cut)));
    for (const line of framed.lines) {
      let item;
      try {
        item = JSON.parse(line.toString('utf8'));
      } catch {
        throw invalid();
      }
      if (!item || typeof item !== 'object' || Array.isArray(item)) throw invalid();
      items.push(item);
    }
  };
  try {
    await pages(hello, call, maxChars, take);
  } finally {
    framer.close();
  }
  if (open || items.length !== hello.rev) throw invalid();
  hello.snapshot = { ...hello.snapshot, items, paged: false };
  delete hello.snapshot.droppedItems;
}

/**
 * Every page of `hello`'s pinned history, in order, each chunk to `take`: a page that is stale, too large, or a cursor that
 * goes nowhere is invalid.
 * @param {any} hello @param {Function} call @param {number} maxChars @param {(chunk: string) => void} take
 */
async function pages(hello, call, maxChars, take) {
  let cursor = { index: 0, offset: 0 },
    size = 0;
  do {
    const page = await call('chat.history', { generation: hello.generation, rev: hello.rev, ...cursor });
    if (
      page?.generation !== hello.generation ||
      page.rev !== hello.rev ||
      typeof page.chunk !== 'string' ||
      page.chunk.length > HISTORY_CHARS
    )
      throw invalid();
    size += page.chunk.length;
    if (size > maxChars) throw invalid();
    take(page.chunk);
    const next = page.next;
    if (
      next !== null &&
      (!next ||
        !Number.isSafeInteger(next.index) ||
        !Number.isSafeInteger(next.offset) ||
        next.offset < 0 ||
        next.index < cursor.index ||
        next.index > hello.rev ||
        (next.index === cursor.index && next.offset <= cursor.offset))
    )
      throw invalid();
    if (next !== null && !page.chunk.length) throw invalid();
    cursor = next;
  } while (cursor);
}
module.exports = { fillHistory };
