// A Claude Code chat's claude.ai artifact and Claude Design calls as the whole thread view shows them: a finished publish is
// its artifact card in the turn (also when the work folds), a running one is a step that says it is publishing, and every
// design call's row reads as what it did with a palette icon, never "Called Artifact".
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createElement as h } from 'react';
import { autoMock } from './support/thread-kit.ts';

autoMock('src/components/thread/ArtifactCard.tsx', 'artifactCards', {
  ArtifactCard: (p: any) => h('div', { 'data-stub': 'ArtifactCard', 'data-url': p.artifact.url, 'data-action': p.artifact.action }),
});
const { render, flush, chat, turn, user, reply, view, text } = await import('./support/thread-view/fixture.ts');
const { isBlockItem, toolCard } = await import('../src/components/thread/items/stepModel.ts');

const URL = 'https://claude.ai/code/artifact/0a21f3e3-1b2c-4d5e-8f90-123456789abc';
const publish = (id: string, out: string | null, extra: any = {}) => ({
  id,
  type: 'mcpToolCall',
  server: '',
  tool: 'Artifact',
  arguments: { file_path: '/w/landing.html', title: 'Landing page' },
  status: out === null ? 'inProgress' : 'completed',
  result: out === null ? null : { content: [{ type: 'text', text: out }] },
  error: null,
  ...extra,
});
const published = publish('a1', `Created a new Artifact at ${URL} (version 1) from Design.`);

test('a finished publish is its artifact card in the turn, in view while the rest of the folded work is hidden', async () => {
  const cmd = { id: 'c1', type: 'commandExecution', command: 'ls', status: 'completed', commandActions: [] };
  chat([turn('t1', [user('u1', 'Make me a landing page'), cmd, published, reply('r1', 'Published it.')])]);
  const v = await render(view());
  await flush();
  const card = v.$('[data-stub="ArtifactCard"]');
  assert.ok(card, 'the publish renders as its card');
  assert.deepEqual([card!.dataset.url, card!.dataset.action], [URL, 'created']);
  assert.doesNotMatch(text(v.host), /Called Artifact/);
  assert.doesNotMatch(text(v.host), /Ran ls/, 'the other work folded');
  await v.unmount();
});

test('only a finished publish naming its page is a card; the rest are steps', () => {
  assert.equal(isBlockItem(published as any), true);
  assert.equal(toolCard(published)?.kind, 'artifact');
  assert.equal(isBlockItem(publish('a2', null) as any), false, 'still running');
  assert.equal(isBlockItem(publish('a3', 'Published, but no link came back.') as any), false);
  assert.equal(isBlockItem({ ...publish('a4', `Created a new Artifact at ${URL}`), server: 'my_mcp' } as any), false);
});

test('design calls read as what they do in the running line, the summary and their rows', async () => {
  const { StepRow } = await import('../src/components/thread/items/StepRow.tsx');
  const { itemSteps, summarizeSteps } = await import('../src/components/thread/items/stepModel.ts');
  const { activeStepLabel } = await import('../src/components/thread/items/presentation.tsx');
  assert.equal(activeStepLabel(itemSteps(publish('a5', null) as any)[0]), 'Publishing artifact');
  const listing = { ...publish('a6', '[]'), arguments: { action: 'list' } };
  assert.equal(summarizeSteps(itemSteps(listing as any)).text, 'Called a tool');
  let v = await render(h(StepRow, { step: itemSteps(listing as any)[0], cwd: '/r' }));
  assert.match(text(v.host), /Listed artifacts/);
  assert.doesNotMatch(text(v.host), /Called/);
  assert.ok(v.$('svg'), 'the row has its icon');
  await v.unmount();
  const design = {
    ...publish('a7', 'x'),
    tool: 'ClaudeDesign',
    arguments: { operation: 'list_projects' },
    status: 'failed',
    error: { message: 'x' },
  };
  v = await render(h(StepRow, { step: itemSteps(design as any)[0], cwd: '/r' }));
  assert.match(text(v.host), /Claude Design · list projects failed/);
  await v.unmount();
});

test('a page published again is one card at its latest version, and its earlier publishes are steps', async () => {
  const again = (id: string, version: number) =>
    publish(id, `Updated the Artifact at ${URL} (version ${version}) with landing.html; own files not sent this time were kept.`);
  const other = 'https://claude.ai/design/p/proj-1234';
  const design = {
    ...publish('d1', `Created ${other}`),
    tool: 'ClaudeDesign',
    arguments: { operation: 'create_project', arguments: { name: 'Onboarding' } },
  };
  // a reply between the publishes splits the turn's work, and the page is still one card
  chat([
    turn('t1', [
      user('u1', 'Iterate on it'),
      published,
      reply('r0', 'First pass.'),
      again('a2', 2),
      design,
      again('a3', 3),
      reply('r1', 'Done.'),
    ]),
  ]);
  const v = await render(view());
  await flush();
  const cards = v.$$('[data-stub="ArtifactCard"]').map((c) => [c.dataset.url, c.dataset.action]);
  assert.deepEqual(cards, [
    [other, 'created'],
    [URL, 'updated'],
  ]);
  await v.unmount();
  const { republished, buildBlocks } = await import('../src/components/thread/items/stepModel.ts');
  assert.deepEqual([...republished([published, again('a2', 2), design, again('a3', 3)])], ['a1', 'a2']);
  const blocks = buildBlocks([published, again('a2', 2)] as any);
  assert.deepEqual(
    blocks.map((b) => b.kind),
    ['steps', 'block'],
    'the earlier publish is a step',
  );
});
