// Claude Code enables and consumes native SDK predictions at the live session boundary.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { useFakePaths } from './support/ports/paths.ts';
import { waitFor } from './support/waitFor.ts';

const { createClaudeHarness } = createRequire(import.meta.url)('../electron/harness/claude/index.cjs');

test('Claude opts in and forwards only an idle valid suggestion outside the transcript stream', async (t) => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'mopilot-claude-suggestion-'));
  useFakePaths(t, cwd);
  const events: any[] = [];
  let enabled = false;
  const claude = createClaudeHarness({
    sdk: async () => ({
      query: ({ prompt, options }: { prompt: AsyncIterable<unknown>; options: { promptSuggestions: boolean } }) => {
        enabled = options.promptSuggestions;
        return {
          close: () => undefined,
          async *[Symbol.asyncIterator]() {
            await prompt[Symbol.asyncIterator]().next();
            yield { type: 'prompt_suggestion', suggestion: 'The prompt is still running.' };
            yield { type: 'result', subtype: 'success' };
            yield { type: 'prompt_suggestion', suggestion: 42 };
            yield { type: 'prompt_suggestion', suggestion: 'Run the focused test.' };
          },
        };
      },
    }),
  });
  claude.register({ handle: () => undefined }, (channel: string, event: object) => channel === 'claude:event' && events.push(event));
  const sessionId = '00000000-0000-4000-8000-000000000003';
  const key = `claude:${sessionId}`;
  await claude.send(key, { bin: process.execPath, sessionId, cwd }, { role: 'user', content: 'Write a test.' });
  await waitFor(() => events.some((e) => e.kind === 'closed'), 'Claude stream ended');
  assert.equal(enabled, true);
  assert.deepEqual(
    events.filter((e) => e.kind === 'promptSuggestion' || e.msg?.type === 'prompt_suggestion'),
    [{ key, kind: 'promptSuggestion', text: 'Run the focused test.' }],
  );
});
