// Notes MoPilot writes into a Codex thread's history (turn/start additionalContext) stay there when the thread
// continues in the ChatGPT/Codex app, so each one is reviewed for what it names. A new writer or key fails here
// until its text is checked against docs/bug-prevention/wrong-scope.md (a note that names MoPilot's own tools).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { treeFiles } from '../scripts/source-tree.mjs';
import { createRequire } from 'node:module';

export const GUARDS = ['electron/', 'shared/'];

const ROOT = join(import.meta.dirname, '..');
const require = createRequire(import.meta.url);
const { IN_APP_BROWSER_CONTEXT } = require('../electron/capabilities/channels/codexConfig.cjs');
const { HISTORY_CONTEXT_KEY } = require('../shared/computerHistory.mjs');
const { historyParams } = require('../electron/harness/codexParams.cjs');
const { PREAMBLE } = require('../electron/computerHistory/digest.cjs');

/** Every key written into additionalContext, and why its text stays true in any app. */
const REVIEWED_KEYS: Record<string, string> = {
  [IN_APP_BROWSER_CONTEXT]: "names MoPilot's tools only after codexConfig.cjs scopeNote (valid while their MCP server is in the tool list)",
  'mopilot.native-runtime-state': "states what happened to the vendor's own cua_repl kernel: true in any app",
  [HISTORY_CONTEXT_KEY]:
    'the memories the user chose to share with this message (#1363), quoted as data with a preamble that names no MoPilot tool or setting: true in any app',
};

test('only reviewed notes are written into a Codex thread’s additionalContext', () => {
  const writers = treeFiles(join(ROOT, 'electron'), /\.(cjs|mjs)$/).filter((f) => /\badditionalContext\b/.test(readFileSync(f, 'utf8')));
  // codexConfig.cjs composes the note from codexThreadContracts.cjs; codexConnection.cjs writes it
  assert.deepEqual(
    writers.map((f) => relative(ROOT, f)),
    [
      'electron/capabilities/channels/codexConfig.cjs',
      'electron/capabilities/channels/codexThreadContracts.cjs',
      'electron/harness/codexConnection.cjs',
      // the memories a user shares with a message (shared/computerHistory.mjs)
      'electron/harness/codexParams.cjs',
    ],
  );
  const text = readFileSync(join(ROOT, 'electron/harness/codexConnection.cjs'), 'utf8');
  const keys = new Set(
    [...text.matchAll(/additionalContext: \{ \.\.\.params\.additionalContext, (?:\[(\w+)\.key\]|'([^']+)'):/g)].map((m) => m[2] ?? m[1]),
  );
  // the turnContext note carries its key as `note.key`; the others are literal keys
  assert.deepEqual([...keys].sort(), ['mopilot.native-runtime-state', 'note'].sort());
  assert.deepEqual(Object.keys(REVIEWED_KEYS).sort(), [
    'mopilot.computer-history',
    'mopilot.in-app-browser',
    'mopilot.native-runtime-state',
  ]);
  // codexParams.cjs writes only the shared-memories key, as untrusted context, and its text names no MoPilot tool
  const block = `<sage-computer-history>\n${PREAMBLE}\n\n## 2026-10-18\n- x\n</sage-computer-history>`;
  assert.deepEqual(Object.keys(historyParams([{ kind: 'computerHistory', path: '', name: 'x', text: block }]).additionalContext), [
    HISTORY_CONTEXT_KEY,
  ]);
  assert.doesNotMatch(PREAMBLE, /\b(browser_|desktop_|sage_|mcp__|Settings)\b/);
});
