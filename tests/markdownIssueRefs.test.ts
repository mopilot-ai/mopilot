// Issue references in the message view: #N links into the chat folder's repository (src/lib/chatRepo.ts) and opens like any link.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createElement as h } from 'react';
import { mockStore, autoMock, stubComponent, render, settle, resetStore, callsTo, moduleCalls, native } from './support/thread-kit.ts';

mockStore();
autoMock('src/session/open.ts', 'open');
autoMock('src/lib/highlight.ts', 'hl');
autoMock('src/components/ui/ImageLightbox.tsx', 'img', { ZoomableImage: stubComponent('ZoomableImage') });
autoMock('src/components/markdown/SkillLink.tsx', 'skill', { SkillLink: stubComponent('SkillLink') });
autoMock('src/components/markdown/Visualization.tsx', 'viz', { Visualization: stubComponent('Visualization') });
autoMock('src/components/markdown/PullRequestLink.tsx', 'prl', { PullRequestLink: () => h('span', { 'data-stub': 'PullRequestLink' }) });
const { Markdown } = await import('../src/components/markdown/Markdown.tsx');
const { chatRepo, resetChatRepos, useChatRepo, useIssueRefs, CHAT_REPO_TTL_MS } = await import('../src/lib/chatRepo.ts');

/** Each folder's origin remote, and the folders read. */
let remotes: Record<string, string | Error> = {};
const reads: string[] = [];
beforeEach(() => {
  resetStore();
  resetChatRepos();
  moduleCalls.length = 0;
  reads.length = 0;
  remotes = { '/repo': 'git@github.com:mopilot-ai/mopilot.git', '/other': 'https://github.com/other/tool' };
  native.git = {
    info: async (cwd: string) => {
      reads.push(cwd);
      const remote = remotes[cwd];
      if (remote instanceof Error) throw remote;
      return remote === undefined ? null : { root: cwd, branch: 'main', remote, branches: ['main'] };
    },
  };
});

const md = (text: string, cwd: string | null = '/repo') => render(h(Markdown, { text, cwd }));

test('a bare #N links into the chat repository and opens through the app as a plain link', async () => {
  const v = await md('问题和方案记在 #2030。 Merged PR #2029.');
  const [issue, pr] = v.$$('a');
  assert.equal(issue.getAttribute('href'), 'https://github.com/mopilot-ai/mopilot/issues/2030');
  assert.equal(issue.textContent, '#2030');
  assert.equal(issue.querySelector('.md-favicon'), null, 'no favicon: the words alone, as Claude Desktop shows them');
  // a pull request reference keeps its words: no chip
  assert.equal(pr.getAttribute('href'), 'https://github.com/mopilot-ai/mopilot/pull/2029');
  assert.equal(pr.textContent, '#2029');
  assert.equal(v.$('[data-stub="PullRequestLink"]'), null);
  await settle(() => issue.click());
  assert.deepEqual(callsTo('open:openMessageLink')[0].slice(0, 2), ['https://github.com/mopilot-ai/mopilot/issues/2030', '/repo']);
  await v.unmount();
});

test('a full pull request URL is still a chip, and a later #N of it links there without a repository', async () => {
  const v = await md('Opened https://github.com/a/b/pull/5 — #5 is ready', '/none');
  assert.ok(v.$('[data-stub="PullRequestLink"]'));
  assert.equal(v.$('a')!.getAttribute('href'), 'https://github.com/a/b/pull/5');
  await v.unmount();
});

test('without a folder, a repository or a known host, a bare #N stays text', async () => {
  for (const cwd of [null, '/none', '/fails']) {
    remotes['/fails'] = new Error('git failed');
    const v = await md('tracked in #2030', cwd);
    assert.equal(v.$('a'), null, String(cwd));
    await v.unmount();
  }
  remotes['/lab'] = 'https://bitbucket.org/t/a';
  const v = await md('tracked in #2030', '/lab');
  assert.equal(v.$('a'), null);
  await v.unmount();
});

test('a folder is read once a minute at most, and again after that', async () => {
  const t0 = 1_000_000;
  assert.deepEqual(await chatRepo('/repo', t0), { host: 'github.com', owner: 'mopilot-ai', repo: 'mopilot' });
  await chatRepo('/repo', t0 + CHAT_REPO_TTL_MS - 1);
  assert.deepEqual(reads, ['/repo']);
  remotes['/repo'] = 'https://github.com/moved/mopilot';
  assert.deepEqual(await chatRepo('/repo', t0 + CHAT_REPO_TTL_MS), { host: 'github.com', owner: 'moved', repo: 'mopilot' });
  assert.deepEqual(reads, ['/repo', '/repo']);
  assert.equal(await chatRepo(undefined), null);
  assert.deepEqual(reads, ['/repo', '/repo']);
});

test("switching folders never shows the previous folder's repository, and a late read is dropped after unmount", async () => {
  const seen: unknown[] = [];
  function Probe({ cwd }: { cwd: string }) {
    seen.push(useChatRepo(cwd));
    return null;
  }
  const v = await render(h(Probe, { cwd: '/repo' }));
  assert.deepEqual(seen.at(-1), { host: 'github.com', owner: 'mopilot-ai', repo: 'mopilot' });
  await v.rerender(h(Probe, { cwd: '/other' }));
  // the first render for the new folder has nothing yet, then the new repository
  assert.ok(seen.includes(null));
  assert.deepEqual(seen.at(-1), { host: 'github.com', owner: 'other', repo: 'tool' });
  const count = seen.length;
  await v.rerender(h(Probe, { cwd: '/other' }));
  assert.equal(seen.length, count + 1, 'the same repository again does not render twice');
  let release!: () => void;
  native.git.info = () =>
    new Promise((resolve) => {
      release = () => resolve({ root: '/late', branch: 'main', remote: 'https://github.com/late/x', branches: [] });
    });
  await v.rerender(h(Probe, { cwd: '/late' }));
  await v.unmount();
  const after = seen.length;
  await settle(() => release());
  assert.equal(seen.length, after);
});

test('what references link with stays the same object while text grows, until the message names a new number', async () => {
  const seen: object[] = [];
  function Probe({ text }: { text: string }) {
    seen.push(useIssueRefs(text, '/repo'));
    return null;
  }
  const v = await render(h(Probe, { text: 'fixes #1' }));
  const settled = seen.at(-1)!;
  await v.rerender(h(Probe, { text: 'fixes #1 and more words' }));
  assert.equal(seen.at(-1), settled, 'a growing reply does not make closed runs parse again');
  await v.rerender(h(Probe, { text: 'fixes #1, see https://github.com/a/b/issues/1' }));
  assert.notEqual(seen.at(-1), settled);
  assert.deepEqual([...(seen.at(-1) as { known: Map<string, string> }).known], [['1', 'https://github.com/a/b/issues/1']]);
  await v.unmount();
});
