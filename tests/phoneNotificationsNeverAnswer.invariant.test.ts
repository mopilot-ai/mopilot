// Approvals from outside the app are narrow (P5): only the needs-you category offers Allow and Deny, only mobile/src/push/approvalAction.ts may send an answer (through the Host client, after device authentication for Allow), and a Live Activity, a widget or any other code never answers.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import '../tests/support/phone/register.ts';
const actionsPath = '../mobile/src/push/actions';
const { CATEGORY_SPECS, OPEN_ACTION, REPLY_ACTION, ALLOW_ACTION, DENY_ACTION } = await import(actionsPath);

const APPROVAL_WORDS = /allow|approve|deny|accept|reject|always|permit|grant|yes\b|no\b|confirm/i;

test('every category offers Open/Review and a Reply draft; only needs-you adds Allow and Deny', () => {
  assert.ok(CATEGORY_SPECS.length > 0);
  for (const spec of CATEGORY_SPECS) {
    assert.deepEqual(
      spec.actions.map((a: any) => a.identifier),
      spec.id === 'mopilot.needsYou' ? [OPEN_ACTION, ALLOW_ACTION, DENY_ACTION, REPLY_ACTION] : [OPEN_ACTION, REPLY_ACTION],
      spec.id,
    );
    for (const a of spec.actions) {
      if (a.identifier === ALLOW_ACTION || a.identifier === DENY_ACTION) continue;
      assert.doesNotMatch(a.buttonTitle, APPROVAL_WORDS, `${spec.id}: ${a.buttonTitle}`);
      if (a.textInput) assert.doesNotMatch(`${a.textInput.submitButtonTitle} ${a.textInput.placeholder}`, APPROVAL_WORDS);
    }
  }
});

const sourcesOf = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? sourcesOf(path) : /\.(tsx?|js|swift|kt)$/.test(name) ? [path] : [];
  });

test('no code that handles a notification, a widget or a Live Activity can answer a request', () => {
  const root = new URL('../mobile', import.meta.url).pathname;
  const files = [...sourcesOf(join(root, 'src/push')), ...sourcesOf(join(root, 'plugins'))];
  assert.ok(files.length > 3);
  for (const file of files) {
    const text = readFileSync(file, 'utf8');
    if (file.endsWith('/push/approvalAction.ts')) continue;
    assert.doesNotMatch(text, /card\.answer|chat\.permit|chat\.answer|momo\.card\.answer/, `${file} must not answer a request`);
    // iOS: an action is registered with UNNotificationAction; none may carry an approval word as its identifier or title
    for (const m of text.matchAll(/UNNotificationAction\([^)]*\)/g)) assert.doesNotMatch(m[0], APPROVAL_WORDS, `${file}: ${m[0]}`);
  }
});
