// ACP content translation, streaming, history and approval edge cases.
import { test, assert } from './fixture.ts';

type AcpModules = typeof import('../../../electron/harness/items/acpTranslator.cjs') &
  typeof import('../../../shared/acpItems/permissionChoices.mjs') &
  typeof import('../../../shared/acpItems/toolItems.mjs') &
  typeof import('../../../shared/acpStop.mjs');

export function registerAcp(acpT: AcpModules) {
  test('ACP content, tool calls and plans become thread items', () => {
    assert.equal(acpT.blockText(null), '');
    assert.equal(acpT.blockText('x'), '');
    assert.equal(acpT.blockText({ type: 'text' }), '');
    assert.equal(acpT.blockText({ type: 'resource_link', uri: 'u', name: 'n' }), '[n](u)');
    assert.equal(acpT.blockText({ type: 'resource_link', uri: 'u', title: 't' }), '[t](u)');
    assert.equal(acpT.blockText({ type: 'resource_link', uri: 'u' }), '[u](u)');
    assert.equal(acpT.blockText({ type: 'resource', resource: { text: 'body' } }), 'body');
    assert.equal(acpT.blockText({ type: 'resource', resource: { blob: 'b' } }), '');
    assert.equal(acpT.blockText({ type: 'image' }), '[image]');
    assert.equal(acpT.blockText({ type: 'audio' }), '');
    const item = (tc: any) => acpT.toolItem({ toolCallId: 1, ...tc }, '/w');
    // edits: a new file, a replaced one
    const edit = item({
      status: 'completed',
      content: [
        { type: 'diff', path: 'a', oldText: null },
        { type: 'diff', path: 'b', oldText: 'x' },
        { type: 'content', content: { type: 'text', text: 'ignored' } },
      ],
    });
    assert.deepEqual(
      (edit as any).changes.map((c: any) => [c.kind.type, c.diff]),
      [
        ['add', ''],
        ['update', '@@ -1,1 +1,1 @@\n-x\n+'],
      ],
    );
    // commands: arrays, strings, the title, output from content or rawOutput
    assert.equal((item({ kind: 'execute', rawInput: { command: ['ls', '-l'] } }) as any).command, 'ls -l');
    assert.equal((item({ kind: 'execute', rawInput: { cmd: 'pwd' }, status: 'failed' }) as any).exitCode, 1);
    assert.equal((item({ kind: 'execute', title: 'Run' }) as any).command, 'Run');
    assert.equal((item({ kind: 'execute' }) as any).command, '');
    assert.equal((item({ kind: 'execute', rawOutput: { output: 'out' } }) as any).aggregatedOutput, 'out');
    assert.equal(
      (item({ kind: 'execute', rawOutput: { output: 1 }, content: [null, { type: 'terminal' }] }) as any).aggregatedOutput,
      null,
    );
    assert.equal(
      (item({ kind: 'execute', status: 'completed', content: [{ type: 'content', content: { type: 'text', text: 'done' } }] }) as any)
        .aggregatedOutput,
      'done',
    );
    // read and search
    assert.deepEqual((item({ kind: 'read', locations: [{ path: '/w/a.ts' }] }) as any).commandActions[0], {
      type: 'read',
      command: 'Read',
      name: 'a.ts',
      path: '/w/a.ts',
    });
    assert.equal((item({ kind: 'read', rawInput: { file_path: '/w/b.ts' }, title: 'Read b' }) as any).command, 'Read b');
    assert.deepEqual((item({ kind: 'read' }) as any).commandActions[0], { type: 'read', command: 'Read', name: '', path: '' });
    assert.equal((item({ kind: 'read', rawInput: { path: '/w/c.ts' } }) as any).command, 'Read /w/c.ts');
    assert.equal((item({ kind: 'read', title: 'T' }) as any).commandActions[0].name, 'T');
    assert.deepEqual((item({ kind: 'search', rawInput: { pattern: 'p' } }) as any).commandActions[0], {
      type: 'search',
      command: 'Search',
      query: 'p',
      path: null,
    });
    assert.equal((item({ kind: 'search', rawInput: { query: 'q' } }) as any).commandActions[0].query, 'q');
    assert.equal((item({ kind: 'search', title: 'Find' }) as any).commandActions[0].query, 'Find');
    assert.equal((item({ kind: 'search' }) as any).commandActions[0].query, null);
    // fetch: a page or a search
    assert.deepEqual((item({ kind: 'fetch', rawInput: { url: 'https://x' } }) as any).action, { type: 'openPage', url: 'https://x' });
    assert.deepEqual((item({ kind: 'fetch', rawInput: { query: 'q' } }) as any).action, { type: 'search', query: 'q' });
    assert.deepEqual((item({ kind: 'fetch', title: 'T' }) as any).query, 'T');
    assert.deepEqual((item({ kind: 'fetch' }) as any).query, '');
    // anything else: a tool card, MCP-named or not
    const mcp = item({
      title: 'mcp__gh__issues',
      status: 'completed',
      content: [{ type: 'content', content: { type: 'text', text: 'r' } }],
    });
    assert.deepEqual(
      [(mcp as any).server, (mcp as any).tool, (mcp as any).result.content],
      ['gh', 'issues', [{ type: 'text', text: 'r' }]],
    );
    assert.deepEqual((item({ status: 'completed' }) as any).result.content, []);
    assert.equal((item({}) as any).tool, 'Tool');
    assert.deepEqual((item({ status: 'failed' }) as any).error, { message: 'Failed' });
    assert.deepEqual((item({ status: 'failed', content: [{ type: 'content', content: { type: 'text', text: 'bad' } }] }) as any).error, {
      message: 'bad',
    });
  });

  test('ACP history: replay records, ends that match, timestamps, and approval choices', () => {
    const turns = acpT.buildAcpTurns(
      [
        { t: 'session', harness: 'kimi', sessionId: 's', cwd: '/w' },
        { t: 'update', turnId: 'orphan', update: { sessionUpdate: 'current_mode_update' } },
        { t: 'user', turnId: 'T1', user: { id: 'u', clientId: null, content: [] }, at: 1000 },
        { t: 'update', turnId: 'T1', update: { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'a' } } },
        { t: 'update', turnId: 'T1', update: { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'b' } }, at: 3000 },
        { t: 'update', turnId: 'T1', update: { sessionUpdate: 'plan', entries: [] } },
        { t: 'end', turnId: 'other', stopReason: 'end_turn' },
        { t: 'end', turnId: 'T1', stopReason: 'end_turn', error: 'x', at: 2000 },
      ] as any,
      'c',
      '/w',
      { live: true },
    );
    assert.equal(turns.length, 1);
    assert.deepEqual([turns[0].status, turns[0].error, turns[0].startedAt, turns[0].durationMs], ['completed', { message: 'x' }, 1, 1000]);
    assert.deepEqual((turns[0].items.find((i: any) => i.type === 'reasoning') as any).summary, ['ab']);
    // a live turn stays open
    assert.equal(
      acpT.buildAcpTurns([{ t: 'user', turnId: 'L', user: { id: 'u', clientId: null, content: [] } }] as any, 'c', '/w', { live: true })[0]
        .status,
      'inProgress',
    );
    const ch = acpT.permissionChoices;
    assert.deepEqual(ch(null as any), { primary: { label: 'OK', result: { optionId: null } }, more: [], deny: { optionId: null } });
    const r = ch([
      { optionId: 'o1', name: '', kind: 'allow_always' },
      { optionId: 'o2', name: 'No', kind: 'reject_always' },
      { optionId: 'o3', name: 'Other', kind: 'other' },
    ]);
    assert.deepEqual([r.primary.label, r.deny.optionId, r.more.map((m) => m.label)], ['o1', 'o2', ['Other']]);
    assert.equal(ch([{ optionId: 'q', name: 'Q', kind: 'other' }]).primary.label, 'Q');
  });
}
