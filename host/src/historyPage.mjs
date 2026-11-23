// Read a bounded, lossless JSON-lines fragment of an immutable journal prefix; oversized individual items span pages instead of being clipped.
import { HISTORY_CHARS } from '../../shared/host/history.mjs';
const stale = () => Object.assign(new Error('This chat history changed. Reopen the chat to read it again.'), { code: 'history_changed' });
export function historyPage(saved, p, encode = (item, _index) => JSON.stringify(item)) {
  if (saved.generation !== p.generation || p.rev > saved.frames.length) throw stale();
  let index = p.index,
    offset = p.offset,
    chunk = '';
  if (index > p.rev || (index === p.rev && offset !== 0)) throw stale();
  while (index < p.rev && chunk.length < HISTORY_CHARS) {
    const wire = encode(saved.frames[index].item, index) + '\n';
    if (offset >= wire.length) throw stale();
    const part = wire.slice(offset, offset + HISTORY_CHARS - chunk.length);
    chunk += part;
    offset += part.length;
    if (offset === wire.length) {
      index++;
      offset = 0;
    }
  }
  return { generation: saved.generation, rev: p.rev, chunk, next: index < p.rev ? { index, offset } : null };
}

/** A small per-journal LRU keeps interleaved chat readers off repeated whole-item encoding, bounded by both entries and UTF-8 bytes. */
export function createHistoryPages(encode = JSON.stringify, { maxEntries = 4, maxBytes = 128 * 1024 * 1024 } = {}) {
  const cache = new Map();
  let bytes = 0;
  return (saved, p) =>
    historyPage(saved, p, (item, index) => {
      const key = JSON.stringify([p.chatId, saved.generation, index]);
      const found = cache.get(key);
      if (found?.item === item) {
        cache.delete(key);
        cache.set(key, found);
        return found.wire;
      }
      if (found) {
        bytes -= found.bytes;
        cache.delete(key);
      }
      const wire = encode(item),
        size = Buffer.byteLength(wire);
      if (size > 64 * 1024 * 1024)
        throw Object.assign(new Error('This history item exceeds the journal read limit.'), { code: 'history_too_large' });
      if (size <= maxBytes) {
        while (cache.size && (cache.size >= maxEntries || bytes + size > maxBytes)) {
          const oldest = cache.keys().next().value;
          bytes -= cache.get(oldest).bytes;
          cache.delete(oldest);
        }
        cache.set(key, { item, wire, bytes: size });
        bytes += size;
      }
      return wire;
    });
}
