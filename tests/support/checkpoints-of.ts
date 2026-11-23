// What the Rust core makes of a Claude Code transcript's text: the checkpoints route, on a file holding it.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { coreCall } = require('../../electron/platform/core.cjs');

/** The rewindable messages of `text`, as `checkpoints()` gets them. @param {string} text */
export async function checkpointsOf(text: string) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'checkpoints-'));
  try {
    const file = path.join(dir, 't.jsonl');
    fs.writeFileSync(file, text);
    return await coreCall('transcript.checkpoints', undefined, JSON.stringify({ file, size: text.length * 4 }));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
