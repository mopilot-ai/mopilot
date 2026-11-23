// The composer's typed commands (SLASH_COMMANDS in src/components/composer/ComposerCommands.ts) say whether they use
// the text typed after them: the composer clears it for one that does and leaves it in the box for the rest, so a
// command that reads `args` without `takesText` would get none, and one that claims it without reading it drops the text.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import './support/dom.ts';

const { SLASH_COMMANDS } = await import('../src/components/composer/ComposerCommands.ts');

test('a typed command declares takesText exactly when its handler reads the text typed after it', () => {
  const wrong = SLASH_COMMANDS.filter((c) => /\bargs\b/.test(String(c.run)) !== !!c.takesText).map((c) => c.name);
  assert.deepEqual(wrong, [], 'set takesText on a command whose run reads args, and only there');
  assert.ok(SLASH_COMMANDS.some((c) => c.takesText) && SLASH_COMMANDS.some((c) => !c.takesText), 'the scan sees both kinds');
});
