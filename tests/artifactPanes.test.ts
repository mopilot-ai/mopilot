// Artifact pane tabs (src/store/artifactPanes.ts) on the real store: one tab per chat and claude.ai page however it is
// linked, a newer version kept on the open tab, a publish opening its page only beside the chat that made it while that
// chat is on screen (and never reopening a pane the user closed), the model's Artifact open, and links, the window's
// "open browser tab" and the pane tool reaching the same tab.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { loadStore, resetAll } from './support/store-harness.ts';

const { store, resetState } = await loadStore();
const { openArtifactTab, onArtifactPublished } = await import('../src/store/artifactPanes.ts');
const { answerPane } = await import('../src/store/windowPanes.ts');
const { openUrl } = await import('../src/session/open.ts');
const st = () => store.useStore.getState();
const artifacts = () => st().paneTabs.filter((t) => t.kind === 'artifact');

const UUID = '0a21f3e3-1b2c-4d5e-8f90-123456789abc';
const URL = `https://claude.ai/code/artifact/${UUID}`;
const DESIGN = 'https://claude.ai/design/p/proj-1234';
const call = (text: string, args: any = { file_path: '/w/a.html', title: 'Landing page' }, extra: any = {}) => ({
  id: 'a1',
  type: 'mcpToolCall',
  server: '',
  tool: 'Artifact',
  arguments: args,
  status: 'completed',
  result: { content: [{ type: 'text', text }] },
  error: null,
  ...extra,
});
const created = call(`Created a new Artifact at ${URL} (version 1) from Design.`);
const updated = (v: number) => call(`Updated the Artifact at ${URL} (version ${v}) with a.html.`, { file_path: '/w/a.html' });

beforeEach(() => {
  resetState();
  resetAll();
  store.useStore.setState({
    route: { name: 'thread', id: 'top' },
    threads: { top: { id: 'top', cwd: '/w/top' } as any, kid: { id: 'kid', cwd: '/w/kid' } as any },
    paneTabs: [],
    paneActive: '',
    diffPanel: { open: false },
  });
});

test('one tab per chat and page, however the page is linked, keeping the newer title and version', () => {
  assert.equal(openArtifactTab({ url: `${URL}?x=1`, title: 'Landing page', version: '1' }), true);
  const [tab] = artifacts();
  assert.deepEqual(
    [tab.ownerChat, tab.artifactKind, tab.title, tab.version, tab.url],
    ['top', 'artifact', 'Landing page', '1', `${URL}?x=1`],
  );
  assert.deepEqual([st().paneActive, st().diffPanel.open, st().paneFull], [tab.id, true, false]);
  // the same page in upper case, with a newer version and no title: the same tab, its title kept
  openArtifactTab({ url: `https://claude.ai/code/artifact/${UUID.toUpperCase()}/`, version: '2' });
  assert.equal(artifacts().length, 1);
  assert.deepEqual([artifacts()[0].title, artifacts()[0].version], ['Landing page', '2']);
  // another chat's view gets its own tab for the page; a design is named by what it is
  openArtifactTab({ url: URL }, 'kid');
  openArtifactTab({ url: DESIGN });
  assert.deepEqual(
    artifacts().map((t) => [t.ownerChat, t.artifactKind, t.title]),
    [
      ['top', 'artifact', 'Landing page'],
      ['kid', 'artifact', 'Artifact'],
      ['top', 'design', 'Claude Design project'],
    ],
  );
  // no chat on screen: a tab every view shows; not a claude.ai page: no tab
  store.useStore.setState({ route: { name: 'home' } as any });
  openArtifactTab({ url: 'https://claude.ai/artifact/Ab3_xY9z' });
  assert.equal(artifacts().at(-1)?.ownerChat, undefined);
  assert.equal(openArtifactTab({ url: 'https://claude.ai.example.com/artifact/Ab3_xY9z' }), false);
  assert.equal(artifacts().length, 4);
});

test('kept current without coming forward', () => {
  openArtifactTab({ url: URL, version: '1' });
  store.useStore.setState({ paneActive: 'other', diffPanel: { open: false } });
  assert.equal(openArtifactTab({ url: URL, version: '2' }, 'top', false), true);
  assert.deepEqual([artifacts()[0].version, st().paneActive, st().diffPanel.open], ['2', 'other', false]);
});

test('a publish opens its page beside its chat while on screen; an update never reopens a pane the user closed', () => {
  // another chat's publish: its card only
  onArtifactPublished('kid', created);
  assert.equal(artifacts().length, 0);
  onArtifactPublished('top', created);
  assert.deepEqual([artifacts().length, st().paneActive, st().diffPanel.open], [1, artifacts()[0].id, true]);
  // with the pane open, an update takes the new version and comes forward
  store.useStore.setState({ paneActive: 'other' });
  onArtifactPublished('top', updated(2));
  assert.deepEqual([artifacts()[0].version, st().paneActive], ['2', artifacts()[0].id]);
  // the user closed the pane: the tab is kept current, the pane stays closed
  store.useStore.setState({ diffPanel: { open: false }, paneActive: 'other' });
  onArtifactPublished('top', updated(3));
  assert.deepEqual([artifacts()[0].version, st().paneActive, st().diffPanel.open], ['3', 'other', false]);
  // the user closed the tab: an update leaves it closed
  store.useStore.setState({ paneTabs: [] });
  onArtifactPublished('top', updated(4));
  assert.equal(artifacts().length, 0);
  // anything else is no page
  onArtifactPublished('top', { type: 'commandExecution', id: 'c' });
  onArtifactPublished('top', call('Published, no link.'));
  assert.equal(artifacts().length, 0);
});

test("the model's Artifact open shows its page in front, only for a finished call on a claude.ai page", () => {
  const open = (url: unknown, extra: any = {}) => call('Opened.', { action: 'open', url }, extra);
  onArtifactPublished('top', open(URL, { status: 'inProgress' }));
  onArtifactPublished('top', open('https://example.com/x'));
  onArtifactPublished('top', open(undefined));
  onArtifactPublished('top', call('Read.', { action: 'read', url: URL }));
  onArtifactPublished('top', { ...open(URL), tool: 'ClaudeDesign' });
  assert.equal(artifacts().length, 0);
  onArtifactPublished('kid', open(URL));
  assert.equal(artifacts().length, 0, "another chat's call");
  onArtifactPublished('top', open(DESIGN));
  assert.deepEqual([artifacts()[0].artifactKind, st().paneActive], ['design', artifacts()[0].id]);
});

test('a link, and the pane tool, reach the same tab', () => {
  openUrl(URL);
  assert.equal(artifacts().length, 1);
  openUrl('https://example.com/');
  assert.equal(st().paneTabs.at(-1)?.kind, 'browser');
  assert.deepEqual(answerPane({ op: 'show_pane', caller: 'top', pane: 'artifact', url: `${URL}#top` }), { outcome: 'shown' });
  assert.equal(artifacts().length, 1);
  assert.equal(st().paneActive, artifacts()[0].id);
  assert.deepEqual(answerPane({ op: 'show_pane', caller: 'top', pane: 'artifact', url: 'https://example.com/' }), { outcome: 'invalid' });
});
