// Exhaust and validate Codex's archived pages before publishing a list or inferring a chat's absence.
import { codexApi } from '../harness/adapters/codexApi';
import type { Thread } from './types';

export async function archivedCodexThreads(): Promise<Thread[]> {
  const threads: Thread[] = [];
  const seen = new Set<string>();
  let cursor: string | undefined;
  for (let page = 0; page < 200; page++) {
    const r = await codexApi.threadList({ limit: 200, archived: true, sortKey: 'updated_at', ...(cursor ? { cursor } : {}) });
    if (!r || !Array.isArray(r.data) || !r.data.every((t) => t && typeof t.id === 'string' && t.id.length > 0))
      throw new Error('Invalid Codex archive page');
    threads.push(...(r.data as Thread[]));
    if (r.nextCursor === null) return threads;
    if (typeof r.nextCursor !== 'string' || !r.nextCursor || seen.has(r.nextCursor)) throw new Error('Invalid Codex archive cursor');
    seen.add(r.nextCursor);
    cursor = r.nextCursor;
  }
  throw new Error('Codex archive pagination limit reached');
}
