// The dev host's long-history scenario in its rich form: replies that are code blocks, tables and lists, so a long chat costs something to draw.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFakeApp } from '../scripts/mobile-dev-host/fakeApp.mjs';
import { createScenarios } from '../scripts/mobile-dev-host/scenarios.mjs';
import { EDGE_REPLIES, EDGE_USER } from '../scripts/mobile-dev-host/fakeData.mjs';

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
  const chatIn = (message: string) => /chat (dev-bench-\d+)/.exec(message)![1];
  return { app, ops: app.ops, run: (name: string, args?: string[]) => scenarios.run(name, args) as string, chatIn };
}

const repliesOf = async (r: ReturnType<typeof rig>, id: string) =>
  (await r.ops.read(id)).rows.filter((x: any) => x.role === 'assistant').map((x: any) => x.text as string);

test('long-history insight is a long finished Claude chat whose every reply has an insight line, a heading, a rule, a link, a code block and a table; plain has the same with neither block (#5351)', async () => {
  const r = rig();
  const id = r.chatIn(r.run('long-history', ['40', 'insight']));
  assert.equal(r.app.chats.get(id).harness, 'claude');
  assert.equal((await r.ops.read(id)).rows.length, 40);
  for (const t of await repliesOf(r, id)) {
    assert.ok(t.includes('★ Insight ───') && t.includes('## Round the total once') && t.includes('\n---\n') && t.includes('](https://'));
    assert.ok(t.includes('```ts') && t.includes('|---|---|---|---|'));
  }
  const plain = r.chatIn(r.run('long-history', ['40', 'plain']));
  assert.equal(r.app.chats.get(plain).harness, 'claude');
  for (const t of await repliesOf(r, plain)) {
    assert.ok(t.includes('★ Insight ───') && t.includes('](https://'));
    assert.ok(!t.includes('```') && !t.includes('|---|'), 'no code block, no table');
  }
  assert.equal(r.app.chats.get(r.chatIn(r.run('long-history', ['10']))).harness, 'codex', 'the other modes stay Codex chats');
});

test('links makes a Claude chat with one reply holding a bare URL, a Markdown link, a wrapped link and two links in a list (#5358)', async () => {
  const r = rig();
  const id = r.chatIn(r.run('links'));
  assert.equal(r.app.chats.get(id).harness, 'claude');
  const [reply] = await repliesOf(r, id);
  assert.match(reply, /A bare URL in a paragraph: https:\/\/example\.com\/a-bare-url and/);
  assert.match(reply, /\[Example docs\]\(https:\/\/example\.com\/docs\)/);
  assert.ok(/\[[^\]]{80,}\]\(https:\/\/example\.com\/docs\/checkout/.test(reply), 'a link text long enough to wrap on a phone');
  assert.match(
    reply,
    /- a link in a list item: \[list link\]\(https:\/\/example\.com\/list\)\n- a bare URL in a list item: https:\/\/example\.com\/list-bare/,
  );
});

test('long-history rich makes the assistant replies code blocks, tables and lists in turn, and keeps the row count', async () => {
  const r = rig();
  const id = r.chatIn(r.run('long-history', ['40', 'rich']));
  const rows = (await r.ops.read(id)).rows;
  assert.equal(rows.length, 40);
  const replies = rows.filter((x: any) => x.role === 'assistant').map((x: any) => x.text as string);
  assert.ok(
    replies.some((t) => t.includes('```ts')) &&
      replies.some((t) => t.includes('|---|---|---|')) &&
      replies.some((t) => t.includes('\n- rounded')),
  );
  assert.ok(
    replies.every((t) => /Message \d+ of 40/.test(t)),
    'every reply keeps its "Message N of M" start',
  );
});

test('long-history edges is a Claude chat of every odd shape the native text views met in #5368, with your own message a URL straight against CJK text', async () => {
  const r = rig();
  const id = r.chatIn(r.run('long-history', ['40', 'edges']));
  assert.equal(r.app.chats.get(id).harness, 'claude');
  const rows = (await r.ops.read(id)).rows;
  assert.equal(rows.length, 40);
  const replies = rows.filter((x: any) => x.role === 'assistant').map((x: any) => x.text as string);
  for (const shape of EDGE_REPLIES) assert.ok(replies.includes(shape), shape);
  assert.ok(replies.some((t) => /\n#\n/.test(t)) && replies.some((t) => t.includes('\n-\n')) && replies.some((t) => t.includes('[](')));
  assert.ok(replies.some((t) => t.includes('| | x |')));
  const mine = rows.filter((x: any) => x.role === 'user').map((x: any) => x.text as string);
  assert.ok(mine.includes(EDGE_USER) && /^https:\/\/\S+[\u4e00-\u9fff]/.test(EDGE_USER));
});
