// Composite-history reads reject older completions, retry changed segments and snapshot the active stream last.
import { beforeEach, mock, test } from 'node:test';
import assert from 'node:assert/strict';
import { fx, reset } from './support/harness-logic-fakes.ts';
import { deferred, tick } from './support/async-scenarios.ts';

mock.module('../src/session/harness/claude.ts', {
  namedExports: Object.fromEntries(
    [
      'loadClaudeTurns',
      'addClaudeAccount',
      'pinClaudeChat',
      'reloginClaudeAccount',
      'removeClaudeAccount',
      'switchClaudeAccount',
      'recheckClaude',
    ].map((n) => [n, async () => []]),
  ),
});
mock.module('../src/store/codexDisk.ts', { namedExports: { allFromDisk: async () => null } });
const { openCompositeThread } = await import('../src/session/harness/switch.ts');
const { loadOlderAcpTurns, openAcpThread } = await import('../src/session/harness/acp.ts');
const { openLatestClaudeTurns } = await import('../src/session/harness/claude/history.ts');
const { pageBytes } = await import('./support/claude-translate.ts');
const segment = (harness: string, nativeId: string, count: number | null = null) => ({
  harness,
  nativeId,
  start: 0,
  count,
  handoff: null,
  model: null,
});
const turn = (id: string) => ({ id, status: 'completed', items: [] });
beforeEach(() => {
  reset();
  fx.state.segments.c = [segment('codex', 'c')];
  fx.store.ensureResumed = async () => undefined;
  fx.store.turnFromServer = (t: any) => t;
});

for (const rejected of [false, true]) {
  test(`an older ${rejected ? 'rejection' : 'success'} cannot overwrite a newer composite read`, async () => {
    const reads = [deferred(), deferred()];
    let n = 0;
    fx.native.codex = { api: () => reads[n++].promise };
    const older = openCompositeThread('c');
    await tick();
    const newer = openCompositeThread('c');
    await tick();
    reads[1].resolve({ data: [turn('new')], nextCursor: null });
    await newer;
    if (rejected) reads[0].reject(new Error('old failure'));
    else reads[0].resolve({ data: [turn('old')], nextCursor: null });
    await older;
    assert.deepEqual(
      fx.state.runtime.c.turns.map((t: any) => t.id),
      ['new'],
    );
    assert.equal(fx.state.runtime.c.loading, false);
    assert.equal(fx.state.runtime.c.error, null);
  });
}

for (const reject of [false, true])
  test(`a segment change retries the new source after an obsolete ${reject ? 'failure' : 'page'}`, async () => {
    const first = deferred();
    let reads = 0;
    fx.native.codex = { api: () => (++reads === 1 ? first.promise : Promise.resolve({ data: [turn('current')], nextCursor: null })) };
    const loading = openCompositeThread('c');
    await tick();
    fx.state.segments.c = [segment('codex', 'new-native')];
    if (reject) first.reject(new Error('obsolete failure'));
    else first.resolve({ data: [turn('retired')], nextCursor: null });
    await loading;
    assert.equal(reads, 2);
    assert.deepEqual(
      fx.state.runtime.c.turns.map((t: any) => t.id),
      ['current'],
    );
  });

test('continuous segment churn stops with a visible retryable error', async () => {
  let reads = 0;
  fx.native.codex = {
    api: async () => {
      fx.state.segments.c = [segment('codex', `new-${++reads}`)];
      return { data: [], nextCursor: null };
    },
  };
  await openCompositeThread('c');
  assert.equal(reads, 4);
  assert.match(fx.state.runtime.c.error, /kept changing/);
  assert.equal(fx.state.runtime.c.loading, false);
});

test('an old native reader cannot clear a replacement composite load after a harness switch', async () => {
  for (const family of ['acp', 'claude'])
    for (const reject of [false, true]) {
      reset();
      const id = family === 'acp' ? 'acp:kimi:loading' : 'claude:loading';
      const oldPage = deferred();
      const newPage = deferred();
      fx.native.session = { snapshot: async () => null };
      fx.native.acp = { turns: () => oldPage.promise };
      fx.native.claude = { turns: () => oldPage.promise };
      fx.native.codex = { api: () => newPage.promise };
      fx.store.ensureResumed = async () => undefined;
      const old = family === 'acp' ? openAcpThread(id) : openLatestClaudeTurns(id, () => assert.fail('obsolete source'));
      await tick();
      fx.state.segments[id] = [segment('codex', 'replacement')];
      const replacement = openCompositeThread(id);
      await tick();
      if (reject) oldPage.reject(new Error('obsolete failure'));
      else oldPage.resolve(pageBytes({ turns: [turn('obsolete')], olderCursor: null, closedTail: null }));
      await old;
      assert.equal(fx.state.runtime[id].loading, true, `${family}/${reject}`);
      assert.equal(fx.state.runtime[id].error, null);
      newPage.resolve({ data: [turn('replacement')], nextCursor: null });
      await replacement;
      assert.deepEqual(
        fx.state.runtime[id].turns.map((t: any) => t.id),
        ['replacement'],
      );
      assert.equal(fx.state.runtime[id].loading, false);
    }
});

test('a live Codex tail advancing during older-page reads survives composite history hydration', async () => {
  const older = Array.from({ length: 60 }, (_, at) => turn(`t${at}`));
  const tail = (text: string) => ({ id: 'live', status: 'inProgress', items: [{ type: 'agentMessage', id: 'm', text }] });
  let text = 'Hel';
  let advanced = false;
  let reads = 0;
  fx.state.runtime.c = { turns: [tail(text)] };
  fx.native.codex = {
    api: async (_method: string, [, params]: [string, any]) => {
      reads++;
      if (params.cursor && !advanced) {
        text = 'Hello';
        advanced = true;
        fx.state.runtime.c.turns = [tail(text)];
      }
      const all = [...older, tail(text)];
      const end = params.cursor ? Number(params.cursor) : all.length;
      const start = Math.max(0, end - params.limit);
      return { data: all.slice(start, end).reverse(), nextCursor: start ? String(start) : null };
    },
  };
  await openCompositeThread('c');
  assert.deepEqual(ids(), [...older.map((t) => t.id), 'live']);
  assert.equal(fx.state.runtime.c.turns.at(-1).items[0].text, 'Hello');
  assert.equal(reads, 4, 'the stale page pair is discarded and read again');
  assert.equal(fx.state.runtime.c.loaded, true);
});

test('the active ACP source is read after intervening native sessions even when it was the first segment', async () => {
  const key = 'acp:opencode:first';
  fx.state.segments.c = [segment('acp:opencode', key, 0), segment('codex', 'intervening', 0), segment('acp:opencode', key)];
  const order: string[] = [];
  fx.native.codex = { api: async () => (order.push('codex'), { data: [], nextCursor: null }) };
  fx.native.acp = {
    turns: async () => (order.push('acp'), { page: new TextEncoder().encode('{"turns":[],"olderCursor":null}'), activeTurnId: null }),
  };
  await openCompositeThread('c');
  assert.deepEqual(order, ['codex', 'acp']);
  assert.equal(fx.state.runtime.c.error, null);
});

/** Main's side of an ACP segment, its pages cut from `turns` as they stand when each is asked for. */
function acpSession(turns: any[], onAsk: (before: string | undefined) => void = () => undefined) {
  const asked: (string | null)[] = [];
  fx.native.acp = {
    turns: async (_id: string, _chat: string, _cwd: string, { limit, before }: { limit: number; before?: string | null }) => {
      asked.push(before ?? null);
      onAsk(before ?? undefined);
      const end = before ? Number(before) : turns.length;
      const start = Math.max(0, end - limit);
      const page = { turns: turns.slice(start, end), olderCursor: start > 0 ? String(start) : null };
      const activeTurnId = turns.findLast((t) => t.status === 'inProgress')?.id ?? null;
      return { page: new TextEncoder().encode(JSON.stringify(page)), activeTurnId, diffs: {} };
    },
  };
  return asked;
}
const many = (count: number) => Array.from({ length: count }, (_, at) => turn(`t${at}`));
const ids = () => fx.state.runtime.c.turns.map((t: any) => t.id);

test('a turn that ends between the pages of the active ACP segment is shown ended, with all its items', async () => {
  const key = 'acp:kimi:s';
  fx.state.segments.c = [segment('acp:kimi', key)];
  const turns = [...many(40), { id: 'T', status: 'inProgress', items: [] }];
  const asked = acpSession(turns, (before) => {
    if (!before) return;
    Object.assign(turns[40], { status: 'completed', items: [{ type: 'agentMessage', id: 'm', text: 'done' }] });
  });
  await openCompositeThread('c');
  assert.deepEqual(asked, [null, '11', null]);
  const shown = fx.state.runtime.c.turns.at(-1);
  assert.deepEqual([shown.id, shown.status, shown.items.length], ['T', 'completed', 1]);
  assert.equal(fx.state.runtime.c.activeTurnId, null);
  assert.deepEqual(
    ids(),
    turns.map((t) => t.id),
  );
});

test('more turns than a page while the active ACP segment is read leave no gap and no copy', async () => {
  const key = 'acp:kimi:s';
  fx.state.segments.c = [segment('acp:kimi', key)];
  const turns = many(40);
  let grown = false;
  const asked = acpSession(turns, (before) => {
    if (!before || grown) return;
    grown = true;
    turns.push(...many(75).slice(40));
  });
  await openCompositeThread('c');
  assert.deepEqual(asked, [null, '10', null, '45', '15', null]);
  assert.deepEqual(
    ids(),
    turns.map((t) => t.id),
  );
});

test('a cursor that stops moving ends a read of every turn, and paging older stops there', async () => {
  const key = 'acp:kimi:s';
  fx.state.segments.c = [segment('acp:kimi', key, 2), segment('codex', 'now')];
  fx.native.codex = { api: async () => ({ data: [turn('now')], nextCursor: null }) };
  const stuck = {
    page: new TextEncoder().encode('{"turns":[{"id":"a","status":"completed","items":[]}],"olderCursor":"7"}'),
    activeTurnId: null,
    diffs: {},
  };
  let reads = 0;
  fx.native.acp = { turns: async () => (reads++, stuck) };
  await openCompositeThread('c');
  assert.equal(reads, 2);
  assert.deepEqual(await loadOlderAcpTurns(key, '9'), { turns: [turn('a')], nextCursor: '7' });
  assert.deepEqual(await loadOlderAcpTurns(key, '7'), { turns: [turn('a')], nextCursor: null });
});

test('an ACP segment no stream reaches, or of one page, is read once', async () => {
  const old = 'acp:kimi:old';
  fx.state.segments.c = [segment('acp:kimi', old, 40), segment('codex', 'now')];
  fx.native.codex = { api: async () => ({ data: [turn('now')], nextCursor: null }) };
  assert.deepEqual(
    await (async () => {
      const asked = acpSession(many(40));
      await openCompositeThread('c');
      return asked;
    })(),
    [null, '10'],
  );
  fx.state.segments.c = [segment('acp:kimi', old)];
  const asked = acpSession(many(3));
  await openCompositeThread('c');
  assert.deepEqual(asked, [null]);
});
