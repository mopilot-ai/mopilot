// src/store/projects.ts runEnvironmentScript: a worktree's setup and cleanup scripts come from main's resolver
// (environment.toml, else Conductor's files), and what main couldn't read is said without stopping the worktree.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { loadStore, callsOf, impl, resolvedEnvironment, resetAll } from './support/store-harness.ts';

const { store: S, resetState } = await loadStore();
const texts = () => S.useStore.getState().toasts.map((t: any) => t.text);
beforeEach(() => {
  resetState();
  resetAll();
});

test("the script main resolved runs in the worktree: Conductor's setup and archive as well as environment.toml's", async () => {
  impl['env.resolve'] = async () => resolvedEnvironment({ source: 'conductor', setup: 'pnpm i', cleanup: './archive.sh' });
  impl['env.runScript'] = async () => ({ exitCode: 0, output: '' });
  await S.runEnvironmentScript('setup', '/w/p', '/wt/p1');
  await S.runEnvironmentScript('cleanup', '/w/p', '/wt/p1');
  assert.deepEqual(callsOf('env.resolve'), [['/w/p'], ['/w/p']]);
  assert.deepEqual(callsOf('env.runScript'), [
    ['/wt/p1', 'pnpm i'],
    ['/wt/p1', './archive.sh'],
  ]);
  assert.deepEqual(texts(), []);
  // a project with no config at all: nothing runs and nothing is said
  delete impl['env.resolve'];
  await S.runEnvironmentScript('setup', '/w/p', '/wt/p1');
  assert.equal(callsOf('env.runScript').length, 2);
  assert.deepEqual(texts(), []);
});

test("Conductor config that is there but can't be read is said, and what could be read still runs", async () => {
  const notice = "Found Conductor config we couldn't read: /w/p/.conductor/settings.local.toml (bad)";
  impl['env.resolve'] = async () => resolvedEnvironment({ source: 'conductor', setup: 'pnpm i', notice });
  impl['env.runScript'] = async () => ({ exitCode: 0, output: '' });
  await S.runEnvironmentScript('setup', '/w/p', '/wt/p1');
  assert.deepEqual(texts(), [notice]);
  assert.deepEqual(callsOf('env.runScript'), [['/wt/p1', 'pnpm i']]);
});

test("an environment.toml that can't be read, or a main that can't be asked, is said and runs nothing", async () => {
  impl['env.resolve'] = async () => resolvedEnvironment({ source: 'environment', error: 'EACCES: permission denied' });
  await S.runEnvironmentScript('cleanup', '/w/p', '/wt/p1');
  impl['env.resolve'] = async () => {
    throw new Error("Error invoking remote method 'env:resolve': Error: invalid");
  };
  await S.runEnvironmentScript('setup', '/w/p', '/wt/p1');
  assert.deepEqual(texts(), ["Couldn't read the cleanup script: EACCES: permission denied", "Couldn't read the setup script: invalid"]);
  assert.equal(callsOf('env.runScript').length, 0);
});
