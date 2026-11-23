// An ACP chat's transcript as the core reads it, for tests of main's readers: records on a real file, under a host's shape.
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { readChatTurns } = require('../../electron/harness/items/acpTranslator.cjs');

type Records = (key: string) => unknown[] | Promise<unknown[]>;

/** An ItemsLog's face for each chat's records as `recordsOf` has them at that read. */
export function transcriptItems(recordsOf: Records) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'acp-transcript-'));
  const held = new Map<string, string>();
  return {
    async flush(key: string) {
      const records = await recordsOf(key);
      held.set(key, records.length ? `${records.map((record) => JSON.stringify(record)).join('\n')}\n` : '');
    },
    file(key: string) {
      const file = path.join(dir, encodeURIComponent(key));
      fs.writeFileSync(file, held.get(key) ?? '');
      return file;
    },
  };
}

/** What an ACP host gives a reader of `recordsOf`. */
export const transcriptHost = (recordsOf: Records) => ({ chats: new Map(), items: transcriptItems(recordsOf) });

/** A peer reader's `acpTurns` over `recordsOf`. */
export const acpTurnsOf = (recordsOf: Records) => (key: string, threadId: string, o: object) =>
  readChatTurns(transcriptHost(recordsOf), key, threadId, o);
