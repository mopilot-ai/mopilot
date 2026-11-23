// Claude Code's claude.ai artifact and Claude Design calls (shared/claudeArtifacts.mjs, src/lib/designToolCall.ts): which
// links are claude.ai pages (and which lookalikes are not), the page a publish made as its result text names it, the line
// each call reads as, and what its approval asks in words.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyClaudeUrl, findClaudeUrl } from '../shared/claudeArtifacts.mjs';
import { artifactCall, designCallLine, designApproval } from '../src/lib/designToolCall.ts';

const UUID = '0a21f3e3-1b2c-4d5e-8f90-123456789abc';
const CODE_URL = `https://claude.ai/code/artifact/${UUID}`;

test('only https claude.ai artifact and design pages are claude.ai pages, one page however it is linked', () => {
  assert.deepEqual(classifyClaudeUrl(CODE_URL), { kind: 'artifact', id: UUID, canonical: CODE_URL });
  assert.deepEqual(classifyClaudeUrl('https://claude.ai/artifact/Ab3_xY9z/?v=2#top'), {
    kind: 'artifact',
    id: 'Ab3_xY9z',
    canonical: 'https://claude.ai/artifact/Ab3_xY9z',
  });
  assert.deepEqual(classifyClaudeUrl('https://CLAUDE.ai/design/p/proj-1234'), {
    kind: 'design',
    id: 'proj-1234',
    canonical: 'https://claude.ai/design/p/proj-1234',
  });
  // a uuid is one id in either case
  assert.deepEqual(classifyClaudeUrl(`https://claude.ai/code/artifact/${UUID.toUpperCase()}/`), {
    kind: 'artifact',
    id: UUID,
    canonical: CODE_URL,
  });
  for (const bad of [
    'http://claude.ai/artifact/Ab3_xY9z',
    'https://claude.ai.example.com/artifact/Ab3_xY9z',
    'https://example.com/artifact/Ab3_xY9z',
    'https://claude.ai@example.com/artifact/Ab3_xY9z',
    'https://user:pw@claude.ai/artifact/Ab3_xY9z',
    'https://:pw@claude.ai/artifact/Ab3_xY9z',
    'https://claude.ai:8443/artifact/Ab3_xY9z',
    'https://x.frame.claudeusercontent.com/index.html',
    'https://claude.ai/code/artifact/not-a-uuid',
    'https://claude.ai/artifact/a/b',
    'https://claude.ai/code/session_123',
    'https://claude.ai/design',
    'not a url',
    42,
    null,
  ])
    assert.equal(classifyClaudeUrl(bad), null, String(bad));
});

test('the first claude.ai page a text names, without the punctuation around it', () => {
  assert.deepEqual(findClaudeUrl(`See \`${CODE_URL}\`. Then https://claude.ai/design/p/proj-1234`), {
    url: CODE_URL,
    kind: 'artifact',
    id: UUID,
    canonical: CODE_URL,
  });
  assert.equal(
    findClaudeUrl('Gallery at https://claude.ai/code/artifacts, then (https://claude.ai/artifact/Ab3_xY9z).')?.url,
    'https://claude.ai/artifact/Ab3_xY9z',
  );
  assert.equal(findClaudeUrl('https://claude.ai/code/artifacts only'), null);
  assert.equal(findClaudeUrl('nothing here'), null);
  assert.equal(findClaudeUrl(undefined), null);
});

const result = (text: string) => ({ content: [{ type: 'text', text }] });
const call = (tool: string, args: Record<string, unknown>, text: string | null, o: Record<string, unknown> = {}) => ({
  type: 'mcpToolCall',
  server: '',
  tool,
  arguments: args,
  status: text === null ? 'inProgress' : 'completed',
  result: text === null ? null : result(text),
  error: null,
  ...o,
});
const CREATED = `Created a new Artifact at ${CODE_URL} (version 1) from Design. File names below are relative.`;
const UPDATED = `Updated the Artifact at https://claude.ai/artifact/Ab3_xY9z (version 3) with page.html; own files not sent this time were kept.`;

test('a publish is the page its result names: new or updated, with its version and title', () => {
  assert.deepEqual(artifactCall(call('Artifact', { file_path: '/w/landing.html', title: 'Landing page' }, CREATED)), {
    url: CODE_URL,
    canonical: CODE_URL,
    kind: 'artifact',
    title: 'Landing page',
    version: '1',
    action: 'created',
  });
  // a same-conversation redeploy names no url in its input, but its result says it updated the page
  const redeploy = artifactCall(call('Artifact', { action: 'publish', file_path: '/w/page.html' }, UPDATED));
  assert.deepEqual([redeploy?.action, redeploy?.version, redeploy?.title, redeploy?.kind], ['updated', '3', null, 'artifact']);
  // a result in other words: an update when the input named the page, else new; no version when none is stated
  const byUrl = artifactCall(call('Artifact', { url: CODE_URL, file_path: '/w/a.html' }, `Published ${CODE_URL}.`));
  assert.deepEqual([byUrl?.action, byUrl?.version], ['updated', null]);
  assert.equal(artifactCall(call('Artifact', { file_path: '/w/a.html', title: '  ' }, `Published ${CODE_URL}.`))?.action, 'created');
  // the result wins over the input: a refused update that created a new page instead
  assert.equal(artifactCall(call('Artifact', { url: CODE_URL }, CREATED))?.action, 'created');
});

test('a Claude Design project write is its project; reads, uploads, failures and other servers are not pages', () => {
  const made = artifactCall(
    call(
      'ClaudeDesign',
      { operation: 'create_project', arguments: { name: 'Onboarding' } },
      'Created https://claude.ai/design/p/proj-1234',
    ),
  );
  assert.deepEqual([made?.kind, made?.title, made?.action], ['design', 'Onboarding', 'created']);
  const wrote = artifactCall(
    call('ClaudeDesign', { operation: 'write_files', arguments: {} }, 'Wrote 3 files to https://claude.ai/design/p/proj-1234'),
  );
  assert.deepEqual([wrote?.action, wrote?.title], ['updated', null]);
  assert.equal(artifactCall(call('ClaudeDesign', { operation: 'read_file' }, 'https://claude.ai/design/p/proj-1234')), null);
  assert.equal(artifactCall(call('ClaudeDesign', { operation: 'toString' }, 'https://claude.ai/design/p/proj-1234')), null);
  assert.equal(artifactCall(call('ClaudeDesign', {}, 'https://claude.ai/design/p/proj-1234')), null);
  assert.equal(artifactCall(call('Artifact', { action: 'read', url: CODE_URL }, CREATED)), null);
  assert.equal(artifactCall(call('Artifact', { url: CODE_URL, asset: true, file_path: '/w/a.png' }, CREATED)), null);
  assert.equal(artifactCall(call('DesignSync', { method: 'write_files' }, CREATED)), null);
  assert.equal(artifactCall(call('Artifact', {}, 'Published, but no link came back.')), null);
  // a typed create whose files didn't reach it is not a published page
  const empty = `Created a new Artifact at ${CODE_URL} (version 1) from the Artifact type x, but publishing the files to it failed: 500.`;
  assert.equal(artifactCall(call('Artifact', {}, empty)), null);
  assert.deepEqual(designCallLine(call('Artifact', {}, empty)), { text: 'Couldn’t publish artifact', failed: true });
  assert.equal(artifactCall(call('Artifact', {}, `Published ${CODE_URL.replace('claude.ai', 'claude.ai.example.com')}`)), null);
  assert.equal(artifactCall(call('Artifact', {}, null)), null, 'still running');
  assert.equal(artifactCall(call('Artifact', {}, CREATED, { status: 'failed' })), null);
  assert.equal(artifactCall(call('Artifact', {}, CREATED, { error: { message: 'x' } })), null);
  assert.equal(artifactCall(call('Artifact', {}, CREATED, { result: { ...result(CREATED), isError: true } })), null);
  assert.equal(artifactCall(call('Artifact', {}, CREATED, { server: 'my_mcp' })), null, "another server's Artifact tool");
  assert.equal(artifactCall(call('Artifact', {}, CREATED, { type: 'dynamicToolCall' })), null);
  assert.equal(artifactCall(call('Artifact', 'x' as any, CREATED))?.action, 'created', 'an input that is not an object');
  assert.equal(artifactCall(call('Read', {}, CREATED)), null);
  assert.equal(artifactCall({ type: 'mcpToolCall', status: 'completed' }), null, 'no tool name');
  assert.equal(artifactCall(null), null);
});

test('each design call reads as what it does, running, done or failed', () => {
  const text = (tool: string, args: Record<string, unknown>, out: string | null, o: Record<string, unknown> = {}) =>
    designCallLine(call(tool, args, out, o))?.text ?? null;
  assert.equal(text('Artifact', { file_path: '/w/a.html' }, null), 'Publishing artifact');
  assert.equal(text('Artifact', { title: 'Landing page' }, CREATED), 'Published Landing page');
  assert.equal(text('Artifact', {}, CREATED), 'Published artifact');
  assert.equal(text('Artifact', { action: 'list' }, '[]'), 'Listed artifacts');
  assert.equal(text('Artifact', { action: 'quickstart', intent: 'design' }, null), 'Looking up artifact types');
  assert.equal(text('Artifact', { action: 'delete_asset' }, 'ok'), 'Deleted artifact file');
  assert.equal(text('Artifact', { action: 'pin' }, 'ok'), 'Pinned artifact');
  assert.equal(text('Artifact', { action: 'sync' }, 'ok'), 'Worked on artifact');
  assert.equal(text('Artifact', { action: 'constructor' }, 'ok'), 'Worked on artifact');
  assert.equal(text('ArtifactComments', {}, null), 'Checking artifact comments');
  assert.equal(text('ArtifactData', {}, '{}'), 'Used artifact data');
  assert.equal(text('ClaudeDesign', { operation: 'list_projects' }, '[]'), 'Claude Design · list projects');
  assert.equal(text('ClaudeDesign', {}, '[]'), 'Claude Design');
  assert.equal(text('ClaudeDesign', { operation: '' }, '[]'), 'Claude Design');
  assert.equal(text('DesignSync', { method: 'finalize_plan' }, null), 'Design sync · finalize plan');
  // a failure reads as one, by its state, error or error result; a call with no status yet is settled
  assert.deepEqual(designCallLine(call('Artifact', {}, CREATED, { status: 'failed' })), {
    text: 'Couldn’t publish artifact',
    failed: true,
  });
  assert.equal(text('Artifact', { action: 'read' }, null, { error: { message: 'x' } }), 'Couldn’t read artifact');
  assert.equal(
    text('ClaudeDesign', { operation: 'write_files' }, 'x', { result: { isError: true } }),
    'Claude Design · write files failed',
  );
  assert.equal(text('Artifact', { action: 'list' }, null, { status: undefined }), 'Listed artifacts');
  // other tools and servers are not design calls
  assert.equal(text('Artifact', {}, CREATED, { server: 'my_mcp' }), null);
  assert.equal(text('Bash', {}, 'x'), null);
});

test('an approval says what the call publishes or changes, in words', () => {
  assert.deepEqual(designApproval('Artifact', { file_path: '/w/site/landing.html', title: 'Landing page' }), {
    kind: 'Artifact',
    message: 'Publish Landing page to claude.ai?',
    lines: ['Title: Landing page', 'File: /w/site/landing.html', 'Private to you on claude.ai until you share it'],
  });
  assert.deepEqual(designApproval('Artifact', { action: 'publish', file_path: '/w/site/landing.html', url: CODE_URL }), {
    kind: 'Artifact',
    message: 'Update this artifact on claude.ai?',
    lines: ['File: /w/site/landing.html', `Updates: ${CODE_URL}`],
  });
  assert.equal(
    designApproval('Artifact', { file_path: '/w/deck.html', url: 'https://example.com/x' })?.message,
    'Publish deck.html to claude.ai?',
  );
  assert.equal(designApproval('Artifact', null)?.message, 'Publish this page to claude.ai?');
  assert.deepEqual(designApproval('Artifact', { action: 'delete', url: CODE_URL }), {
    kind: 'Artifact',
    message: 'Delete this artifact? Its link stops working for everyone.',
    lines: [CODE_URL],
  });
  assert.equal(designApproval('Artifact', { action: 'delete' })?.lines, null);
  assert.equal(
    designApproval('Artifact', { action: 'upload_asset', asset: true, url: CODE_URL })?.message,
    'Use artifacts on claude.ai (upload asset)?',
  );
  assert.equal(designApproval('Artifact', { asset: true })?.message, 'Use artifacts on claude.ai (publish)?');
  assert.deepEqual(designApproval('ClaudeDesign', { operation: 'write_files', arguments: {} }), {
    kind: 'Claude Design',
    message: 'Run write files in Claude Design?',
    lines: null,
  });
  assert.equal(designApproval('DesignSync', {})?.message, 'Use Claude Design?');
  assert.equal(designApproval('ArtifactData', {})?.message, 'Use this artifact on claude.ai?');
  assert.equal(designApproval('Bash', {}), null);
  assert.equal(designApproval(undefined, {}), null);
});
