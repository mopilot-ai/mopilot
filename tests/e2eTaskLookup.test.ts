// tests/e2e/fixtures/tasks.ts against the store's real id rule: the E2E specs find the tasks they create by name, so a
// change to how electron/platform/automationStore.cjs names a new task fails here, in the pull request's unit tests,
// rather than in the release's E2E run (#851 broke two specs that way).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { createdTaskFile, createdTaskText } from './e2e/fixtures/tasks.ts';

const require = createRequire(import.meta.url);
const { uniqueId } = require('../electron/platform/automationStore.cjs');

test('a task the store names is found by the name the E2E specs give it; others, none and two are told apart', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-tasks-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const automations = path.join(dir, 'automations');
  assert.equal(createdTaskFile(automations, 'Weekly finances update'), '');
  // the names cuj-scheduled-tasks.spec.ts and claude-only.spec.ts create
  for (const name of ['Weekly finances update', 'summarize the repo nightly']) {
    const id = uniqueId(name, new Set());
    fs.mkdirSync(path.join(automations, id), { recursive: true });
    assert.equal(createdTaskText(automations, name), '', 'no file yet');
    fs.writeFileSync(path.join(automations, id, 'automation.toml'), `name = "${name}"\n`);
    assert.equal(createdTaskFile(automations, name), path.join(automations, id, 'automation.toml'));
    assert.equal(createdTaskText(automations, name), `name = "${name}"\n`);
  }
  // a task whose name only shares a prefix is not this one; a fixture task stored under the bare slug is
  fs.mkdirSync(path.join(automations, 'weekly'));
  fs.mkdirSync(path.join(automations, 'nightly-check'));
  assert.equal(createdTaskFile(automations, 'Nightly check'), path.join(automations, 'nightly-check', 'automation.toml'));
  fs.mkdirSync(path.join(automations, uniqueId('Weekly finances update', new Set())));
  assert.throws(() => createdTaskFile(automations, 'Weekly finances update'), /more than one task named Weekly finances update/);
});
