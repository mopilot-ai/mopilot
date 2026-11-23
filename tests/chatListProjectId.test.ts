// list_sidebar and the phone's chat list name a chat's project by id too, so two projects of one name stay two.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { listChats } = require('../electron/capabilities/tools/chatList.cjs');

const rec = (kind: string, meta: Record<string, unknown> = {}) => ({
  segments: [{ kind }],
  meta: { archived: null, projectId: null, worktreeOf: null, ...meta },
});
const H = 3600_000;

test('two projects of one name tell their chats apart by project id: a saved project by its id, an unsaved folder by a hash that is not its path', () => {
  const world2 = {
    projects: [
      { id: 'a1', name: 'app', path: '/Users/me/work/app' },
      { id: 'a2', name: 'app', path: '/Users/me/play/app' },
    ],
    records: new Map<string, any>([
      ['c1', rec('codex', { projectId: 'a1' })],
      ['c2', rec('codex', { projectId: 'a2' })],
      ['c3', rec('codex')],
      ['c4', rec('codex')],
      ['c5', rec('codex')],
    ]),
    natives: [] as [string, string[]][],
    sessions: {
      codex: [
        { key: 'c1', title: 'One', cwd: '/Users/me/work/app', at: 5 * H },
        { key: 'c2', title: 'Two', cwd: '/Users/me/play/app', at: 4 * H },
        { key: 'c3', title: 'Three', cwd: '/tmp/x/docs', at: 3 * H },
        { key: 'c4', title: 'Four', cwd: '/tmp/y/docs', at: 2 * H },
        { key: 'c5', title: 'Five', cwd: '/tmp/x/docs/', at: 1 * H },
        { key: 'c6', title: 'Six', cwd: null, at: 0 },
      ],
    },
  };
  const rows = listChats(world2, {}).chats;
  const by = (id: string) => rows.find((c: any) => c.id === id);
  assert.deepEqual([by('c1').project, by('c2').project], ['app', 'app']);
  assert.deepEqual([by('c1').projectId, by('c2').projectId], ['a1', 'a2']);
  // folders of one name stay two projects, and one folder written two ways stays one
  assert.equal(by('c3').project, 'docs');
  assert.equal(by('c4').project, 'docs');
  assert.notEqual(by('c3').projectId, by('c4').projectId);
  assert.equal(by('c3').projectId, by('c5').projectId);
  assert.match(by('c3').projectId, /^folder:[0-9a-f]{12}$/);
  assert.doesNotMatch(JSON.stringify(rows.map((c: any) => c.projectId)), /tmp|Users/, 'no path leaves the Mac in an id');
  // what tells the twins apart is the last parent folders, as the sidebar shows them: said for a shared name only, never the path
  assert.deepEqual([by('c1').projectHint, by('c2').projectHint], ['work', 'play']);
  assert.deepEqual([by('c3').projectHint, by('c4').projectHint, by('c5').projectHint], ['x', 'y', 'x']);
  assert.equal('projectHint' in by('c6'), false, 'a chat of no project has none');
  assert.equal(by('c6').projectId, null);
});
