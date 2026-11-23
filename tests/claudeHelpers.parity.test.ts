// What both sides still read of a Claude Code message, held to one answer: how a `result` ended, goals, findings and token usage
// stay in JS for the controller, the adapter and the window, and the Rust crate has them for the translator
// (core/crates/translate/src/claude/parity.rs reads the same fixture, made by the JS translator before it was deleted).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { claudeResultErrors, claudeResultFailed } from '../shared/claudeResult.mjs';
import { tokenUsage } from '../shared/claudeItems/tokenUsage.mjs';
import { claudeGoalNote, claudeLocalOutput, parseClaudeGoalMessage } from '../shared/claudeGoals.mjs';
import { findingsMarkdown, reportedFindings } from '../shared/reviewFindings.mjs';

const folder = new URL('./fixtures/core/translate/claude-helpers/', import.meta.url);
const cases: any[] = fs
  .readdirSync(folder)
  .sort()
  .flatMap((part) => JSON.parse(fs.readFileSync(new URL(part, folder), 'utf8')));

/** A helper's answer as JSON, `"threw"` for what it threw on. */
function spelled(run: () => unknown) {
  try {
    return JSON.stringify(run() ?? null);
  } catch {
    return '"threw"';
  }
}

test('the helpers left in JS answer as the fixture says', () => {
  assert.ok(cases.length >= 1000, `${cases.length} cases`);
  for (const c of cases) {
    const message = JSON.parse(c.message);
    const input = JSON.parse(c.input);
    assert.equal(
      spelled(() => claudeResultErrors(message)),
      c.errors,
      c.message,
    );
    assert.equal(
      spelled(() => claudeResultFailed(message)),
      c.failed,
      c.message,
    );
    assert.equal(
      spelled(() => tokenUsage(message, null)),
      c.usage,
      c.message,
    );
    const goal = () => {
      const parsed = parseClaudeGoalMessage(message);
      return parsed && claudeGoalNote(parsed, claudeLocalOutput(message));
    };
    assert.equal(spelled(goal), c.goal, c.message);
    const review = () => {
      const { level, findings } = reportedFindings(input);
      return { review: findingsMarkdown(findings), level, findings };
    };
    assert.equal(spelled(review), c.review, c.input);
  }
});
