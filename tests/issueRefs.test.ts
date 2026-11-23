// Issue and pull request references in message prose: which #N link where (src/lib/issueRefs.ts), after Claude Desktop's rules.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ReactMarkdown from 'react-markdown';
import { remarkPlugins } from '../src/lib/markdownMath.ts';
import { findIssueRefs, issueRefUrl, knownRefs, remarkIssueRefs, repoFromRemote, type IssueRepo } from '../src/lib/issueRefs.ts';

const repo: IssueRepo = { host: 'github.com', owner: 'mopilot-ai', repo: 'mopilot' };
const issue = (n: number | string) => `https://github.com/mopilot-ai/mopilot/issues/${n}`;
const pull = (n: number | string) => `https://github.com/mopilot-ai/mopilot/pull/${n}`;
/** What each reference in `text` covers and links to. */
const refs = (text: string, options: Partial<Parameters<typeof findIssueRefs>[1]> = {}) =>
  findIssueRefs(text, { repo, known: new Map(), ...options }).map((r) => [text.slice(r.start, r.end), r.url]);

test('a git remote names its repository on GitHub and GitLab, in https, ssh and scp form', () => {
  assert.deepEqual(repoFromRemote('https://github.com/mopilot-ai/mopilot.git'), repo);
  assert.deepEqual(repoFromRemote('https://www.GitHub.com/mopilot-ai/mopilot/'), repo);
  assert.deepEqual(repoFromRemote('git@github.com:mopilot-ai/mopilot.git'), repo);
  assert.deepEqual(repoFromRemote('ssh://git@github.com:22/mopilot-ai/mopilot'), repo);
  assert.deepEqual(repoFromRemote(' https://user:token@github.com/mopilot-ai/mopilot \n'), repo);
  assert.deepEqual(repoFromRemote('git@github.com-work:mopilot-ai/mopilot.git'), repo, 'an ssh alias for a second account');
  assert.deepEqual(repoFromRemote('git@gitlab.example.com:team/app.git'), { host: 'gitlab.example.com', owner: 'team', repo: 'app' });
  // a host whose issue URLs are not known, a nested path, nothing
  assert.equal(repoFromRemote('https://bitbucket.org/team/app.git'), null);
  assert.equal(repoFromRemote('https://github.com/a/b/c'), null);
  assert.equal(repoFromRemote('/local/bare.git'), null);
  assert.equal(repoFromRemote(''), null);
  assert.equal(repoFromRemote(null), null);
  assert.equal(repoFromRemote(undefined), null);
});

test('issue and pull request URLs follow the host', () => {
  assert.equal(issueRefUrl(repo, '7', false), issue(7));
  assert.equal(issueRefUrl(repo, '7', true), pull(7));
  const lab = { host: 'gitlab.com', owner: 't', repo: 'a' };
  assert.equal(issueRefUrl(lab, '7', false), 'https://gitlab.com/t/a/-/issues/7');
  assert.equal(issueRefUrl(lab, '7', true), 'https://gitlab.com/t/a/-/merge_requests/7');
});

test('a keyword before #N makes it a reference, of any length; PR keywords link the pull request', () => {
  assert.deepEqual(refs('This fixes #7.'), [['#7', issue(7)]]);
  assert.deepEqual(refs('see issue #12 and bug: #13'), [
    ['#12', issue(12)],
    ['#13', issue(13)],
  ]);
  assert.deepEqual(refs('Merged PR #2029 into main'), [['#2029', pull(2029)]]);
  assert.deepEqual(refs('the pull request (#45)'), [['#45', pull(45)]]);
  assert.deepEqual(refs('MR: #8'), [['#8', pull(8)]]);
});

test('3+ digits after a neutral lead-in or a CJK character are references; other numbers are not', () => {
  assert.deepEqual(refs('#2030 covers it'), [['#2030', issue(2030)]]);
  assert.deepEqual(refs('(#2030)'), [['#2030', issue(2030)]]);
  assert.deepEqual(refs('tracked in #2030'), [['#2030', issue(2030)]]);
  assert.deepEqual(refs('Done - #2030'), [['#2030', issue(2030)]]);
  assert.deepEqual(refs('问题和方案记在 #2030。'), [['#2030', issue(2030)]]);
  assert.deepEqual(refs('见#2030'), [['#2030', issue(2030)]]);
  // short numbers need a keyword; a word that is not a lead-in does not make one
  assert.deepEqual(refs('in #12'), []);
  assert.deepEqual(refs('step #12 and color #333 and item #2030'), []);
  // colors and codes: a leading zero, or a color property before the lead-in
  assert.deepEqual(refs('background: #000; fix #007'), []);
  assert.deepEqual(refs('color: #333333 and border-color - #123456'), []);
  assert.deepEqual(refs('Score: #100'), [['#100', issue(100)]]);
  // not a reference: part of a word, an entity, a URL fragment
  assert.deepEqual(refs('fixes a#123 and &#123; and fix x/#123'), []);
});

test('a list carries the decision of its first reference', () => {
  assert.deepEqual(refs('Closes #12, #13 and #14'), [
    ['#12', issue(12)],
    ['#13', issue(13)],
    ['#14', issue(14)],
  ]);
  assert.deepEqual(refs('PRs: PR #5 / #6'), [
    ['#5', pull(5)],
    ['#6', pull(6)],
  ]);
  assert.deepEqual(refs('fixes #12/#13'), [
    ['#12', issue(12)],
    ['#13', issue(13)],
  ]);
  // too far from the last one, or joined by other words: decided alone
  assert.deepEqual(refs('fixes #12, and unrelated words here #13'), [['#12', issue(12)]]);
  // a list that did not start with a reference carries nothing
  assert.deepEqual(refs('step #1, #2 and #3'), []);
});

test('short numbers in bold, italics and headings are not linked, even with a keyword', () => {
  assert.deepEqual(refs('fix #12', { emphasized: true }), []);
  assert.deepEqual(refs('fix #123', { emphasized: true }), [['#123', issue(123)]]);
  assert.deepEqual(refs('fix #12', { emphasized: true, known: new Map([['12', issue(12)]]) }), []);
});

test('owner/repo#N always links to that repository, as a pull request after a PR keyword', () => {
  assert.deepEqual(refs('see other-org/tool#5'), [['other-org/tool#5', 'https://github.com/other-org/tool/issues/5']]);
  assert.deepEqual(refs('merged PR mopilot-ai/mopilot#2029'), [['mopilot-ai/mopilot#2029', pull(2029)]]);
  // a word pair or a file is not a repository
  assert.deepEqual(refs('fixes and/or#12 in src/foo.ts#123'), []);
  // a repository name ending in "-" or "." takes the #N too: one link, not two
  assert.deepEqual(refs('see a/b-#123', { known: knownRefs('a/b-#123', repo) }), [['a/b-#123', 'https://github.com/a/b-/issues/123']]);
  assert.deepEqual(refs('a/b#1', { repo: null }), [['a/b#1', 'https://github.com/a/b/issues/1']]);
  assert.deepEqual(refs('x a/b#1', { repo: { host: 'gitlab.com', owner: 'o', repo: 'r' } }), [
    ['a/b#1', 'https://gitlab.com/a/b/-/issues/1'],
  ]);
});

test('an owner/repo named before the keyword overrides the chat repository', () => {
  assert.deepEqual(refs('other/tool issue #5'), [['#5', 'https://github.com/other/tool/issues/5']]);
  assert.deepEqual(refs("(other/web-app)'s PR #6"), [['#6', 'https://github.com/other/web-app/pull/6']]);
  assert.deepEqual(refs(' issue #7', { code: 'other/site-docs' }), [['#7', 'https://github.com/other/site-docs/issues/7']]);
  // a bare name is mostly a label, not a repository (main-red, fixes-main): the chat repository
  assert.deepEqual(refs('the main-red issue #1525'), [['#1525', issue(1525)]]);
  assert.deepEqual(refs('fixes-main PR #2040'), [['#2040', pull(2040)]]);
  assert.deepEqual(refs(' PR #12', { code: 'fixes-main' }), [['#12', pull(12)]]);
  // a file or a word pair before the keyword, inline code with a space: the chat repository
  assert.deepEqual(refs('src/notes.md issue #9'), [['#9', issue(9)]]);
  assert.deepEqual(refs('and/or issue #10'), [['#10', issue(10)]]);
  assert.deepEqual(refs(' issue #11', { code: 'has space' }), [['#11', issue(11)]]);
  // a hint on an earlier line does not reach a later one
  assert.deepEqual(refs('other/tool\nissue #12'), [['#12', issue(12)]]);
});

test('without a chat repository only numbers the message already names link', () => {
  assert.deepEqual(refs('fixes #2030', { repo: null }), []);
  assert.deepEqual(refs('fixes #2030', { repo: null, known: new Map([['2030', pull(2030)]]) }), [['#2030', pull(2030)]]);
  // a known number links even where a bare one would not
  assert.deepEqual(refs('item #55', { known: new Map([['55', issue(55)]]) }), [['#55', issue(55)]]);
  // a number named with two repositories links to neither, nor to the chat repository
  assert.deepEqual(refs('fixes #55', { known: new Map([['55', null]]) }), []);
  assert.deepEqual(refs('fixes #55', { repo: null, known: new Map([['55', null]]) }), []);
});

test('a message learns numbers from its issue and pull request links and owner/repo#N; two repositories make one ambiguous', () => {
  const known = knownRefs(
    [
      'https://github.com/a/b/pull/1 and https://github.com/a/b/pull/1',
      'https://gitlab.com/t/x/-/issues/2 and https://gitlab.com/t/x/-/merge_requests/3',
      'https://github.com/a/b/issues/4 and https://github.com/c/d/issues/4',
      'PR e/f#5 and https://example.com/a/b/issues/6',
    ].join('\n'),
    { host: 'gitlab.com', owner: 't', repo: 'x' },
  );
  assert.deepEqual(Object.fromEntries(known), {
    '1': 'https://github.com/a/b/pull/1',
    '2': 'https://gitlab.com/t/x/-/issues/2',
    '3': 'https://gitlab.com/t/x/-/merge_requests/3',
    '4': null,
    '5': 'https://gitlab.com/e/f/-/merge_requests/5',
  });
  assert.deepEqual(Object.fromEntries(knownRefs('a/b#1', null)), { '1': 'https://github.com/a/b/issues/1' });
});

/** Markdown rendered with the plugin, as the message view renders it. */
const html = (text: string, chatRepo: IssueRepo | null = repo) =>
  renderToStaticMarkup(
    createElement(
      ReactMarkdown,
      { remarkPlugins: [...remarkPlugins, [remarkIssueRefs, { repo: chatRepo, known: knownRefs(text, chatRepo) }]] },
      text,
    ),
  );

test('the plugin links references in prose, keeping the words around them, and marks them as references', () => {
  assert.equal(html('问题和方案记在 #2030。'), `<p>问题和方案记在 <a href="${issue(2030)}" data-issue-ref="">#2030</a>。</p>`);
  assert.equal(html('#2030'), `<p><a href="${issue(2030)}" data-issue-ref="">#2030</a></p>`);
  assert.equal(
    html('fixes #1 and #2 then'),
    `<p>fixes <a href="${issue(1)}" data-issue-ref="">#1</a> and <a href="${issue(2)}" data-issue-ref="">#2</a> then</p>`,
  );
  assert.equal(html('nothing here'), '<p>nothing here</p>');
});

test('the plugin leaves code and existing links alone, and short numbers in emphasis', () => {
  assert.equal(
    html('`fixes #2030` and [fixes #2031](https://x.test)'),
    '<p><code>fixes #2030</code> and <a href="https://x.test">fixes #2031</a></p>',
  );
  assert.equal(html('```\nfixes #2030\n```'), '<pre><code>fixes #2030\n</code></pre>');
  assert.equal(
    html('**fix #12** and *fix #123*'),
    `<p><strong>fix #12</strong> and <em>fix <a href="${issue(123)}" data-issue-ref="">#123</a></em></p>`,
  );
  assert.equal(html('## Step #2\n- fix #3'), `<h2>Step #2</h2>\n<ul>\n<li>fix <a href="${issue(3)}" data-issue-ref="">#3</a></li>\n</ul>`);
});

test('the plugin uses the inline code before a reference as a repository hint, and the message links for bare numbers', () => {
  assert.equal(
    html('`other/site-docs` issue #7'),
    `<p><code>other/site-docs</code> issue <a href="https://github.com/other/site-docs/issues/7" data-issue-ref="">#7</a></p>`,
  );
  assert.equal(
    html('Opened https://github.com/a/b/pull/5. Then #5 again', null),
    '<p>Opened <a href="https://github.com/a/b/pull/5">https://github.com/a/b/pull/5</a>. Then <a href="https://github.com/a/b/pull/5" data-issue-ref="">#5</a> again</p>',
  );
});
