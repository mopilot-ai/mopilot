// Claude Code's Artifact tool switch (electron/harness/claude/artifacts.cjs): the variable a session starts with, the Settings
// switch and its file, the restart of idle sessions when it changes, and what the artifacts capability reads of it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fakes, load, fakeBin, flush, until, tmp, lastQuery } from './support/electron-claude.ts';

const require = createRequire(import.meta.url);
const { artifactEnv, createArtifacts, ARTIFACT_ENV, KILL_FLAG } = require('../electron/harness/claude/artifacts.cjs');
const { recentIgnored, clearIgnored } = require('../electron/ignored.cjs');
const bin = fakeBin('artifacts/claude');
const user = (text: string) => ({ role: 'user', content: text });

test('on, the variable is set only where the environment has none; off, it is forced to 0', () => {
  const env = { PATH: '/bin', CLAUDE_CODE_ENTRYPOINT: 'sdk-ts' };
  assert.deepEqual(artifactEnv(env, true), { ...env, CLAUDE_CODE_ARTIFACT: '1' });
  // the user's own value wins while the switch is on
  for (const own of ['0', 'false', '1', '']) assert.equal(artifactEnv({ ...env, [ARTIFACT_ENV]: own }, true)[ARTIFACT_ENV], own);
  assert.equal(artifactEnv({ ...env, [ARTIFACT_ENV]: '1' }, false)[ARTIFACT_ENV], '0');
  assert.equal(artifactEnv(env, false)[ARTIFACT_ENV], '0');
  // pure: the entry point is left alone and the input is not changed
  assert.equal(artifactEnv(env, false).CLAUDE_CODE_ENTRYPOINT, 'sdk-ts');
  assert.deepEqual(env, { PATH: '/bin', CLAUDE_CODE_ENTRYPOINT: 'sdk-ts' });
});

test('the switch is off by default, on only once the user turns it on (kept in a file), and the kill switch wins', () => {
  fakes.userData = fs.mkdtempSync(path.join(tmp, 'art-'));
  const restarts: number[] = [];
  let killed = false;
  const a = createArtifacts({ restartIdle: () => restarts.push(1), isEnabled: (k: string) => k !== KILL_FLAG || !killed });
  // G10: a user who never touched the switch carries no Artifact tool (~11.8k tokens a request)
  assert.deepEqual(a.view(), { on: false, killed: false });
  assert.equal(a.artifactsOn(), false);
  // the pre-G10 off file is left behind by an older build: on removes it, and the on file is what keeps it on
  fs.writeFileSync(path.join(fakes.userData, 'claude-artifacts-off'), '1');
  assert.deepEqual(a.setArtifacts(true), { on: true, killed: false });
  assert.equal(fs.existsSync(path.join(fakes.userData, 'claude-artifacts-on')), true);
  assert.equal(fs.existsSync(path.join(fakes.userData, 'claude-artifacts-off')), false);
  assert.equal(a.artifactsOn(), true);
  // a new run reads the file: an explicit on survives
  assert.equal(createArtifacts({ restartIdle: () => {}, isEnabled: () => true }).userOn(), true);
  assert.deepEqual(a.setArtifacts(false), { on: false, killed: false });
  assert.equal(fs.existsSync(path.join(fakes.userData, 'claude-artifacts-on')), false);
  assert.equal(createArtifacts({ restartIdle: () => {}, isEnabled: () => true }).userOn(), false);
  assert.equal(restarts.length, 2);
  a.setArtifacts(true);
  killed = true;
  assert.equal(a.artifactsOn(), false);
  assert.deepEqual(a.view(), { on: true, killed: true });
});

test('a switch that cannot be saved still holds for this run, is noted, and restarts idle sessions', () => {
  clearIgnored();
  // no such folder: writing the on file fails
  fakes.userData = path.join(tmp, 'missing', 'userData');
  let restarts = 0;
  const a = createArtifacts({ restartIdle: () => restarts++, isEnabled: () => true });
  assert.deepEqual(a.setArtifacts(true), { on: true, killed: false });
  assert.equal(a.artifactsOn(), true);
  assert.equal(restarts, 1);
  assert.ok(recentIgnored().some((e: any) => e.context === 'save the Claude Code artifacts choice'));
  // a folder where the on file should be: removing it fails, and off still holds
  fakes.userData = fs.mkdtempSync(path.join(tmp, 'art-'));
  fs.mkdirSync(path.join(fakes.userData, 'claude-artifacts-on', 'inner'), { recursive: true });
  assert.deepEqual(a.setArtifacts(false), { on: false, killed: false });
  assert.equal(a.artifactsOn(), false);
  assert.equal(restarts, 2);
});

test('the IPC answers the switch, and a change tells the windows their capabilities changed', async () => {
  const t = load();
  let probes = 0;
  t.claude.setProbeListener(() => probes++);
  assert.deepEqual(await t.call('claude:artifacts'), { on: false, killed: false });
  assert.deepEqual(await t.call('claude:setArtifacts', 'yes'), { on: true, killed: false });
  assert.deepEqual(await t.call('claude:artifacts'), { on: true, killed: false });
  assert.deepEqual(await t.call('claude:setArtifacts', 0), { on: false, killed: false });
  assert.equal(probes, 2);
  // the default `changed` hands back what it is given
  const handlers = new Map<string, (...a: any[]) => any>();
  createArtifacts({ restartIdle: () => {}, isEnabled: () => true }).registerIpc({ handle: (n: string, fn: any) => handlers.set(n, fn) });
  assert.deepEqual(handlers.get('claude:setArtifacts')!({}, true), { on: true, killed: false });
});

test('a session starts with the Artifact tool on and keeps the forced keys; turning it off restarts the idle CLI with it off', async () => {
  const t = load();
  fakes.run = () => ({ stdout: '' });
  // off by default (G10): the user turns it on
  await t.call('claude:setArtifacts', true);
  const key = 'claude:art';
  await t.claude.send(key, { bin, sessionId: 'art' }, user('hi'));
  const first = lastQuery();
  assert.equal(first.options.env.CLAUDE_CODE_ARTIFACT, '1');
  assert.equal(first.options.env.CLAUDE_CODE_REPORT_FINDINGS, '1');
  assert.equal(first.options.env.CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS, '1');
  // the init's tools say whether the process has it, for the capability's session layer
  assert.equal(t.claude.artifactsOf(key).tool, null);
  first.push({ type: 'system', subtype: 'init', tools: ['Bash', 'Artifact'] });
  await until('the init', () => t.claude.artifactsOf(key).tool === true);
  await until('the reply', () => !t.claude.ownBusy(key));
  assert.deepEqual(t.claude.artifactsOf(key), { on: true, tool: true, stale: false, claudeAi: true });
  assert.equal(t.claude.artifactsOf(null).tool, null);

  await t.call('claude:setArtifacts', false);
  await until('the idle CLI ended', () => !t.claude.turnApi.isLive(key));
  await t.claude.send(key, { bin, sessionId: 'art' }, user('again'));
  const second = lastQuery();
  assert.notEqual(second, first);
  assert.equal(second.options.env.CLAUDE_CODE_ARTIFACT, '0');
  second.push({ type: 'system', subtype: 'init', tools: ['Bash'] });
  await until('the init', () => t.claude.artifactsOf(key).tool === false);
  assert.equal(t.claude.artifactsOf(key).on, false);
  assert.equal(t.claude.artifactsOf(key).stale, false);
  await until('the reply', () => !t.claude.ownBusy(key));
  // the switch is not billing: a subscription's messages still say they ran on the login (usage, limits, #1582)
  const messages = t.events.filter((e: any) => e.key === key && e.kind === 'message');
  assert.ok(messages.length > 0);
  assert.ok(messages.every((e: any) => e.login === true));
  assert.equal(t.claude.billingSig(), 'subscription');
  await t.call('claude:control', key, 'close');
  await flush();
});

test('a user-exported CLAUDE_CODE_ARTIFACT=0 reaches the CLI while the switch is on; a key login is not claude.ai', async () => {
  process.env.CLAUDE_CODE_ARTIFACT = '0';
  try {
    const t = load();
    fakes.run = () => ({ stdout: '' });
    await t.claude.send('claude:own0', { bin, sessionId: 'own0', ephemeral: true }, user('hi'));
    assert.equal(lastQuery().options.env.CLAUDE_CODE_ARTIFACT, '0');
    await until('the reply', () => !t.claude.ownBusy('claude:own0'));
    await t.call('claude:control', 'claude:own0', 'close');
    await t.call('claude:setApiKey', 'sk-ant-1');
    assert.equal(t.claude.artifactsOf(null).claudeAi, false);
  } finally {
    delete process.env.CLAUDE_CODE_ARTIFACT;
  }
});

test('a process the switch cannot restart (a temporary chat) is marked as started on the old value', async () => {
  const t = load();
  fakes.run = () => ({ stdout: '' });
  const key = 'claude:temp';
  await t.call('claude:setArtifacts', true);
  await t.claude.send(key, { bin, sessionId: 'temp', ephemeral: true }, user('hi'));
  lastQuery().push({ type: 'system', subtype: 'init', tools: ['Artifact'] });
  await until('the init', () => t.claude.artifactsOf(key).tool === true);
  await until('the reply', () => !t.claude.ownBusy(key));
  await t.call('claude:setArtifacts', false);
  await flush();
  // a temporary chat writes nothing to disk, so its process is not restarted on a toggle
  assert.equal(t.claude.turnApi.isLive(key), true);
  assert.deepEqual(t.claude.artifactsOf(key), { on: false, tool: true, stale: true, claudeAi: true });
  await t.call('claude:setArtifacts', true);
  assert.equal(t.claude.artifactsOf(key).stale, false);
  await t.call('claude:control', key, 'close');
});
