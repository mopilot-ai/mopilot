// The dev host's `projects` scenario: chats of several projects for the Chats home by project (#4819), with the logins the Mac names and which of them is the computer's default.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFakeApp } from '../scripts/mobile-dev-host/fakeApp.mjs';
import { createScenarios } from '../scripts/mobile-dev-host/scenarios.mjs';

function rig() {
  const app = createFakeApp({
    repo: '/repo',
    log: () => undefined,
    now: () => 9_000_000,
    sleep: async () => undefined,
    status: async () => '',
  });
  app.bind({ attached: true, onFeedEvent: () => undefined, onSessionPatch: () => undefined });
  const scenarios = createScenarios({ app, now: () => 9_000_000, after: () => undefined, controls: undefined as any });
  return { ops: app.ops, run: (name: string) => scenarios.run(name, []) as string };
}

test('projects makes chats of two same-named projects, a chat of no project and the logins the Mac names, with the default one flagged', async () => {
  const r = rig();
  assert.equal(
    'projectHint' in (((await r.ops.recent(50)) as any[]).find((c) => c.id === 'dev-seed-readme') ?? {}),
    false,
    'one dev-repo alone has none',
  );
  assert.match(r.run('projects'), /six chats/);
  const made = ((await r.ops.recent(50)) as any[]).filter((c) => c.title.startsWith('[bench] '));
  assert.deepEqual(made.map((c) => [c.title.slice(8), c.project, c.projectId]).sort(), [
    ['loose: newest', null, null],
    ['repo one: running', 'dev-repo', 'dev-repo'],
    ['repo two: idle', 'dev-repo', 'dev-repo-2'],
    ['repo two: running', 'dev-repo', 'dev-repo-2'],
    ['web: idle', 'web-app', 'web-app'],
    ['web: running', 'web-app', 'web-app'],
  ]);
  const byTitle = (t: string) => made.find((c) => c.title === `[bench] ${t}`);
  assert.deepEqual([byTitle('web: idle').account, byTitle('web: idle').accountDefault], ['me@mopilot.example', true]);
  assert.deepEqual(
    [byTitle('repo two: running').account, 'accountDefault' in byTitle('repo two: running')],
    ['work@mopilot.example', false],
  );
  // two projects named dev-repo are told apart by their folders, as the Mac's list does it; a name of its own says nothing
  assert.deepEqual([byTitle('repo one: running').projectHint, byTitle('repo two: running').projectHint], ['code', 'work']);
  assert.equal('projectHint' in byTitle('web: running'), false);
  const readmeRow = ((await r.ops.recent(50)) as any[]).find((c) => c.id === 'dev-seed-readme');
  assert.equal(readmeRow.projectHint, 'code', 'the seeded dev-repo is the first of them');
  assert.equal('accountDefault' in byTitle('web: running'), false, 'a chat with no login to name says nothing of a default');
  // the seeded README chat names its login too, and is not the default one
  const readme = ((await r.ops.recent(50)) as any[]).find((c) => c.id === 'dev-seed-readme');
  assert.equal('accountDefault' in readme, false);
});
