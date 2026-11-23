// Packaged failure evidence captures surviving owned caches while respecting removed-cache and symlink boundaries.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { collectNpmLogs } from './packaged/diagnostics.mjs';

test('npm failure evidence follows stable managed cache ownership without following links', (t) => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'mopilot-npm-evidence-'));
  t.after(() => fs.rmSync(scratch, { recursive: true, force: true }));
  const userData = path.join(scratch, 'user-data');
  const output = path.join(scratch, 'evidence');
  const managed = path.join(userData, 'registry-agents/.packages');
  const write = (file: string, value: string) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, value);
  };
  write(path.join(scratch, 'npm-cache/_logs/fallback.log'), 'fallback');
  write(path.join(managed, 'agent/version/_logs/install.log'), 'managed');
  write(path.join(managed, 'plain-file'), 'skip non-directory agents');
  write(path.join(managed, 'agent/plain-file'), 'skip non-directory versions');
  write(path.join(managed, 'agent/no-logs/ready'), 'no npm logs');
  write(path.join(managed, 'agent/file-logs/_logs'), 'not a log directory');
  write(path.join(scratch, 'outside/secret'), 'private');
  fs.symlinkSync(path.join(scratch, 'outside'), path.join(managed, 'linked-agent'));
  fs.symlinkSync(path.join(scratch, 'outside'), path.join(managed, 'agent/linked-version'));
  fs.symlinkSync(path.join(scratch, 'outside/secret'), path.join(managed, 'agent/version/_logs/linked.log'));
  fs.mkdirSync(path.join(managed, 'agent/linked-logs'));
  fs.symlinkSync(path.join(scratch, 'outside'), path.join(managed, 'agent/linked-logs/_logs'));

  collectNpmLogs({ scratch, userData, output });
  assert.equal(fs.readFileSync(path.join(output, 'npm-logs/managed/agent/version/install.log'), 'utf8'), 'managed');
  assert.equal(fs.readFileSync(path.join(output, 'npm-logs/fallback/fallback.log'), 'utf8'), 'fallback');
  const report = JSON.parse(fs.readFileSync(path.join(output, 'npm-logs/collection.json'), 'utf8'));
  assert.deepEqual(report.copied.sort(), ['fallback/fallback.log', 'managed/agent/version/install.log']);
  assert.deepEqual(report.errors, []);
  assert.match(report.note, /unpublished.*removed.*unavailable/i);
  assert.equal(fs.existsSync(path.join(output, 'npm-logs/managed/linked-agent')), false);
  assert.equal(fs.existsSync(path.join(output, 'npm-logs/managed/agent/version/linked.log')), false);

  fs.rmSync(path.join(scratch, 'npm-cache'), { recursive: true });
  fs.rmSync(managed, { recursive: true });
  const absent = path.join(scratch, 'absent-evidence');
  collectNpmLogs({ scratch, userData, output: absent });
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(absent, 'npm-logs/collection.json'), 'utf8')).copied, []);

  fs.mkdirSync(path.dirname(managed), { recursive: true });
  fs.symlinkSync(path.join(scratch, 'outside'), managed);
  fs.mkdirSync(path.join(scratch, 'npm-cache'));
  fs.symlinkSync(path.join(scratch, 'outside'), path.join(scratch, 'npm-cache/_logs'));
  const linked = path.join(scratch, 'linked-evidence');
  collectNpmLogs({ scratch, userData, output: linked });
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(linked, 'npm-logs/collection.json'), 'utf8')).copied, []);
  fs.unlinkSync(managed);
  fs.unlinkSync(path.join(scratch, 'npm-cache/_logs'));

  write(path.join(scratch, 'npm-cache/_logs/failed.log'), 'retained source');
  t.mock.method(fs, 'copyFileSync', () => {
    throw new Error('copy unavailable');
  });
  const failure = path.join(scratch, 'failed-evidence');
  collectNpmLogs({ scratch, userData, output: failure });
  const failed = JSON.parse(fs.readFileSync(path.join(failure, 'npm-logs/collection.json'), 'utf8'));
  assert.deepEqual(failed.copied, []);
  assert.deepEqual(failed.errors, ['Error: copy unavailable']);
  assert.equal(fs.readFileSync(path.join(scratch, 'npm-cache/_logs/failed.log'), 'utf8'), 'retained source');
});

for (const method of ['mkdirSync', 'writeFileSync'] as const)
  test(`an evidence ${method} failure cannot replace the original journey error`, (t) => {
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'mopilot-npm-evidence-output-'));
    t.after(() => fs.rmSync(scratch, { recursive: true, force: true }));
    t.mock.method(fs, method, () => {
      throw new Error('evidence unavailable');
    });
    let result: any;
    assert.doesNotThrow(() => {
      result = collectNpmLogs({ scratch, userData: path.join(scratch, 'user-data'), output: path.join(scratch, 'evidence') });
    });
    assert.deepEqual(result.errors, ['Error: evidence unavailable']);
    assert.deepEqual(result.copied, []);
  });
