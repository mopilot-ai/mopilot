// A replayed Claude slash command keeps its arguments (core/crates/translate/src/claude).
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { buildTurns } = await import('./support/claude-translate.ts');

const prompt = (text: string) => {
  const turns = buildTurns(
    [
      {
        type: 'user',
        uuid: 'u1',
        timestamp: new Date(0).toISOString(),
        message: { role: 'user', content: text },
        parent_tool_use_id: null,
      },
    ],
    'claude:x',
    '/repo',
  );
  const item: any = turns[0]?.items.find((i: any) => i.type === 'userMessage');
  return item?.content?.[0]?.text;
};

test('a slash command reloads with its arguments, however the tags are laid out', () => {
  // as Claude Code writes it: name, message and args on their own lines
  assert.equal(
    prompt(
      '<command-name>/goal</command-name>\n            <command-message>goal</command-message>\n            <command-args>implement the parser</command-args>',
    ),
    '/goal implement the parser',
  );
  assert.equal(
    prompt('<command-message>review</command-message>\n<command-name>/review</command-name>\n<command-args>PR 12</command-args>'),
    '/review PR 12',
  );
  assert.equal(prompt('<command-name>/review</command-name><command-args>PR 12</command-args>'), '/review PR 12');
  assert.equal(
    prompt('<command-name>/clear</command-name>\n<command-message>clear</command-message>\n<command-args></command-args>'),
    '/clear',
  );
});
