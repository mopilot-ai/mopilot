// Read the actual persisted default harness for E2E assertions, without the application's runtime fallback.
import fs from 'node:fs';
import path from 'node:path';
import { isHarnessKind, type HarnessKindValue } from '../../../shared/defaultHarness.mjs';
import { isJsonRecord } from '../../../shared/jsonRecord.mjs';

/** Missing or unreadable state is a failed assertion, never evidence that the default was saved as Codex. */
export function savedDefaultHarness(harness: { dir: string }): HarnessKindValue {
  const file = path.join(harness.dir, 'userData', 'ui-state.json');
  const state: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!isJsonRecord(state) || !isJsonRecord(state.prefs) || !isHarnessKind(state.prefs.defaultHarness))
    throw new Error(`No valid persisted defaultHarness in ${file}`);
  return state.prefs.defaultHarness;
}
