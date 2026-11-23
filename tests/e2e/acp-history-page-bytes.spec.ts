// An ACP chat's page is a view into the core's reply, past its byte and line of ids: it crosses real IPC and the context bridge.
import fs from 'node:fs';
import path from 'node:path';
import { test, expect } from './fixtures/app';

const KEY = 'acp:kimi:paged';
const conversation = ['a', 'b', 'c'].flatMap((id) => [
  { t: 'user', turnId: id, user: { id: `u-${id}`, clientId: null, content: [{ type: 'text', text: `prompt ${id}` }] } },
  { t: 'update', turnId: id, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: `日本語 😀 ${id}` } } },
  { t: 'end', turnId: id, stopReason: 'end_turn' },
]);

test('a page reaches the window as just its own bytes, and an older page from the same read does too', async ({ page, harness }) => {
  const threads = path.join(harness.dir, 'userData', 'threads');
  fs.mkdirSync(threads, { recursive: true });
  const lines = conversation.map((record) => JSON.stringify(record)).join('\n');
  fs.writeFileSync(path.join(threads, `${encodeURIComponent(KEY)}.items.jsonl`), `${lines}\n`);

  const read = (opts: { limit: number; before?: string }) =>
    page.evaluate(
      async ({ key, opts }) => {
        const { page, activeTurnId, diffs } = await (window as any).native.acp.turns(key, key, '/tmp', opts);
        return { bytes: page instanceof Uint8Array, text: new TextDecoder().decode(page), activeTurnId, diffs };
      },
      { key: KEY, opts },
    );
  const reply = async (opts: { limit: number; before?: string }) => {
    const { bytes, text, activeTurnId, diffs } = await read(opts);
    expect(bytes).toBe(true);
    expect({ activeTurnId, diffs }).toEqual({ activeTurnId: null, diffs: {} });
    // the byte and the line of ids ahead of the page, had they crossed too, would make this throw
    return JSON.parse(text) as { turns: { id: string; items: { text?: string }[] }[]; olderCursor: string | null };
  };

  const latest = await reply({ limit: 2 });
  expect(latest.turns.map((turn) => turn.id)).toEqual(['b', 'c']);
  expect(latest.olderCursor).toBe('1');
  expect(latest.turns[1].items.at(-1)?.text).toBe('日本語 😀 c');

  const older = await reply({ limit: 2, before: latest.olderCursor ?? undefined });
  expect(older.turns.map((turn) => turn.id)).toEqual(['a']);
  expect(older.olderCursor).toBeNull();
  expect(older.turns[0].items.at(-1)?.text).toBe('日本語 😀 a');
});
