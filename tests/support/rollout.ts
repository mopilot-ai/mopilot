// A rollout's text read as the app reads a file, through the real core (core/crates/rollout), for a test that needs Codex turns.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { core } = require('../../electron/platform/core.cjs');

/** The folder and turns of a rollout holding `text`. */
export function parseRollout(text: string) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rollout-'));
  const file = path.join(dir, 'rollout.jsonl');
  fs.writeFileSync(file, text);
  const call = (route: string, payload: string) => JSON.parse(String(core().dispatchSync(route, Buffer.from(payload))));
  try {
    const { id, cwd, count } = call('rollout.open', file);
    const turns = call('rollout.page', `${id} 0 ${count}`);
    call('rollout.close', String(id));
    return { cwd, turns };
  } finally {
    fs.rmSync(dir, { recursive: true });
  }
}
