// Renderer helpers behind native browser and computer control: frame-batched stream deltas
// (src/lib/streamNotifications.ts), screenshots in tool output (src/lib/toolOutput.ts), MCP
// elicitation answers and Codex's native app approval (src/harness/elicitation.ts), and the status
// strip's order with native-control cleanup (src/lib/statusStrip.ts).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createStreamNotifications } from '../src/lib/streamNotifications.ts';
import { imageSrc, toolOutput } from '../src/lib/toolOutput.ts';
import { elicitationAnswer, nativeAppAnswer, nativeAppApproval } from '../src/harness/elicitation.ts';
import { pickChip, pickStrip } from '../src/lib/statusStrip.ts';

const PNG = 'iVBORw0KGgo=';
const delta = (delta: unknown, itemId = 'i1', extra: Record<string, unknown> = {}) => ({
  threadId: 't',
  turnId: 'u',
  itemId,
  delta,
  ...extra,
});

/** A schedule the test runs by hand; counts how often it was asked and cancelled. */
function manual() {
  const s = { paints: [] as (() => void)[], cancels: 0, paint: () => s.paints.splice(0).forEach((p) => p()) };
  const schedule = (paint: () => void) => {
    s.paints.push(paint);
    return () => void s.cancels++;
  };
  return { s, schedule };
}

/* ---------- streamNotifications ---------- */

test('text and thinking deltas wait for the paint and are joined per item into one update', () => {
  const out: [string, any][] = [];
  const { s, schedule } = manual();
  const d = createStreamNotifications((m, p) => out.push([m, p]), schedule);
  d.emit('item/agentMessage/delta', delta('Hel'));
  d.emit('item/agentMessage/delta', delta('lo'));
  d.emit('item/reasoning/summaryTextDelta', delta('think', 'r1', { summaryIndex: 0 }));
  d.emit('item/reasoning/summaryTextDelta', delta('ing', 'r1', { summaryIndex: 0 }));
  assert.deepEqual(out, [], 'nothing is applied before the paint');
  assert.equal(s.paints.length, 1, 'one paint is scheduled for the whole batch');
  s.paint();
  assert.deepEqual(out, [
    ['item/agentMessage/delta', delta('Hello')],
    ['item/reasoning/summaryTextDelta', delta('thinking', 'r1', { summaryIndex: 0 })],
  ]);
  // the next delta schedules a new paint
  d.emit('item/agentMessage/delta', delta('!'));
  assert.equal(s.paints.length, 1);
  s.paint();
  assert.deepEqual(out.at(-1), ['item/agentMessage/delta', delta('!')]);
});

test('deltas are joined only when every other field matches, so no item, index or identity is lost', () => {
  const out: [string, any][] = [];
  const { s, schedule } = manual();
  const d = createStreamNotifications((m, p) => out.push([m, p]), schedule);
  d.emit('item/agentMessage/delta', delta('a', 'i1'));
  d.emit('item/agentMessage/delta', delta('b', 'i2')); // another item
  d.emit('item/agentMessage/delta', delta('c', 'i2', { extra: 1, summaryIndex: 0 })); // another field count
  d.emit('item/reasoning/summaryTextDelta', delta('d', 'i2', { extra: 1, summaryIndex: 0 })); // another method
  d.emit('item/reasoning/summaryTextDelta', delta('e', 'i2', { other: 1, summaryIndex: 0 })); // same count, another key
  d.emit('item/reasoning/summaryTextDelta', delta('f', 'i2', { other: 2, summaryIndex: 0 })); // same key, another value
  s.paint();
  assert.deepEqual(
    out.map(([, p]) => p.delta),
    ['a', 'b', 'c', 'd', 'e', 'f'],
  );
});

test("the caller's params are never changed by joining", () => {
  const out: [string, any][] = [];
  const { s, schedule } = manual();
  const d = createStreamNotifications((m, p) => out.push([m, p]), schedule);
  const first = delta('one ');
  d.emit('item/agentMessage/delta', first);
  d.emit('item/agentMessage/delta', delta('two'));
  s.paint();
  assert.equal(first.delta, 'one ');
  assert.equal(out[0][1].delta, 'one two');
});

test('every other notification first applies what is pending, keeping the transcript order', () => {
  const out: [string, any][] = [];
  const { s, schedule } = manual();
  const d = createStreamNotifications((m, p) => out.push([m, p]), schedule);
  d.emit('item/agentMessage/delta', delta('before'));
  d.emit('item/completed', { threadId: 't', item: { id: 'i1' } });
  assert.deepEqual(
    out.map(([m]) => m),
    ['item/agentMessage/delta', 'item/completed'],
  );
  assert.equal(s.cancels, 1, 'the scheduled paint is cancelled');
  s.paint(); // the cancelled paint has nothing left to apply
  assert.equal(out.length, 2);
  // Non-text notifications keep their own payload contract and flush pending text.
  d.emit('item/agentMessage/delta', delta('held'));
  d.emit('custom/progress', delta({ not: 'text' }));
  assert.deepEqual(
    out.slice(2).map(([, p]) => p.delta),
    ['held', { not: 'text' }],
  );
});

test('flush applies what is held now and is a no-op when nothing is', () => {
  const out: [string, any][] = [];
  const { s, schedule } = manual();
  const d = createStreamNotifications((m, p) => out.push([m, p]), schedule);
  d.flush();
  assert.equal(out.length, 0);
  assert.equal(s.cancels, 0);
  d.emit('item/agentMessage/delta', delta('x'));
  d.flush();
  assert.deepEqual(out, [['item/agentMessage/delta', delta('x')]]);
  assert.equal(s.cancels, 1);
});

test('the default schedule paints on the next animation frame and cancels the fallback timer', async (t) => {
  const g = globalThis as any;
  const frames = new Map<number, () => void>();
  const cancelled: number[] = [];
  let next = 0;
  t.after(() => {
    delete g.requestAnimationFrame;
    delete g.cancelAnimationFrame;
  });
  g.requestAnimationFrame = (cb: () => void) => (frames.set(++next, cb), next);
  g.cancelAnimationFrame = (id: number) => void cancelled.push(id);
  const out: string[] = [];
  const d = createStreamNotifications((_m, p) => out.push(String(p.delta)));
  d.emit('item/agentMessage/delta', delta('frame'));
  assert.equal(frames.size, 1);
  frames.get(1)!();
  assert.deepEqual(out, ['frame']);
  assert.deepEqual(cancelled, [1]);
  // the 50ms timer was cleared with it: nothing is applied twice
  await new Promise((r) => setTimeout(r, 70));
  assert.deepEqual(out, ['frame']);
});

test('a background window without frames still paints within 50ms', async (t) => {
  const g = globalThis as any;
  t.after(() => {
    delete g.requestAnimationFrame;
    delete g.cancelAnimationFrame;
  });
  const out: string[] = [];
  // no requestAnimationFrame at all
  const d = createStreamNotifications((_m, p) => out.push(String(p.delta)));
  d.emit('item/agentMessage/delta', delta('timer'));
  assert.deepEqual(out, []);
  await new Promise((r) => setTimeout(r, 80));
  assert.deepEqual(out, ['timer']);
  // frames requested but never produced, and no cancelAnimationFrame: the timer still paints
  const frames: (() => void)[] = [];
  g.requestAnimationFrame = (cb: () => void) => (frames.push(cb), 7);
  d.emit('item/agentMessage/delta', delta('hidden'));
  await new Promise((r) => setTimeout(r, 80));
  assert.deepEqual(out, ['timer', 'hidden']);
  assert.equal(frames.length, 1);
});

/* ---------- toolOutput ---------- */

test('image blocks in all three shapes become data: URLs; their text is not base64 JSON', () => {
  const mcp = { type: 'image', data: PNG, mimeType: 'image/png' };
  const anthropic = { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: PNG } };
  const snake = { type: 'image', source: { type: 'base64', mime_type: 'image/webp', data: PNG } };
  const codex = { type: 'inputImage', imageUrl: `data:image/gif;base64,${PNG}` };
  const out = toolOutput({ result: { content: [{ type: 'text', text: 'Took a screenshot' }, mcp, anthropic, snake] } });
  assert.deepEqual(out.images, [`data:image/png;base64,${PNG}`, `data:image/jpeg;base64,${PNG}`, `data:image/webp;base64,${PNG}`]);
  assert.equal(out.text, 'Took a screenshot');
  assert.doesNotMatch(out.text, new RegExp(PNG.slice(0, 6)));
  assert.deepEqual(toolOutput({ contentItems: [{ type: 'inputText', text: 'Codex' }, codex] }), {
    text: 'Codex',
    images: [codex.imageUrl],
  });
});

test('images the app does not show inline are named, never rendered', () => {
  const blocks = [
    { type: 'image', data: '<svg/>', mimeType: 'image/svg+xml' }, // not a raster type
    { type: 'image', source: { type: 'url', url: 'https://example.com/a.png', media_type: 'image/png' } }, // not inline
    { type: 'inputImage', imageUrl: 'https://example.com/a.png' }, // a remote URL
    { type: 'inputImage', imageUrl: 'data:text/html;base64,PGgxPg==' }, // not an image
    { type: 'image', mimeType: 'image/png', data: 42 }, // no data
    { type: 'image', data: PNG }, // no type named
    { type: 'image' },
  ];
  const out = toolOutput({ result: { content: blocks } });
  assert.deepEqual(out.images, []);
  assert.deepEqual(out.text.split('\n'), Array(blocks.length).fill('Image preview unavailable'));
});

test('imageSrc is null for anything that is not an inline image block', () => {
  assert.equal(imageSrc(null), null);
  assert.equal(imageSrc(undefined), null);
  assert.equal(imageSrc({ type: 'text', text: 'x' }), null);
  assert.equal(imageSrc({ data: PNG, mimeType: 'image/png' }), `data:image/png;base64,${PNG}`);
});

test('errors, text and other blocks show as before', () => {
  assert.deepEqual(toolOutput({ error: { message: 'boom' }, result: { content: [{ type: 'image', data: PNG, mimeType: 'image/png' }] } }), {
    text: 'boom',
    images: [],
  });
  assert.deepEqual(toolOutput({ result: { content: [{ type: 'resource', uri: 'file:///a' }] } }), {
    text: JSON.stringify({ type: 'resource', uri: 'file:///a' }, null, 2),
    images: [],
  });
  assert.deepEqual(toolOutput({ result: {} }), { text: '', images: [] });
  assert.deepEqual(toolOutput({}), { text: '', images: [] });
  assert.deepEqual(toolOutput(null), { text: '', images: [] });
  assert.deepEqual(toolOutput({ error: {}, contentItems: [null] }), { text: 'null', images: [] });
});

/* ---------- elicitation ---------- */

test('an elicitation answer carries content only for an accepted form, and no client metadata', () => {
  assert.deepEqual(elicitationAnswer('accept', { name: 'x' }, 'form'), { action: 'accept', content: { name: 'x' }, _meta: null });
  assert.deepEqual(elicitationAnswer('accept', { name: 'x' }, undefined), { action: 'accept', content: { name: 'x' }, _meta: null });
  assert.deepEqual(elicitationAnswer('accept', { name: 'x' }, 'url'), { action: 'accept', content: null, _meta: null });
  assert.deepEqual(elicitationAnswer('decline', { name: 'x' }, 'form'), { action: 'decline', content: null, _meta: null });
  assert.deepEqual(elicitationAnswer('cancel', { name: 'x' }, 'form'), { action: 'cancel', content: null, _meta: null });
});

const appRequest = (o: { persist?: unknown; schema?: any; meta?: any; mode?: string } = {}) => ({
  serverName: 'cua_repl',
  mode: o.mode ?? 'form',
  message: 'Allow Codex to use Safari?',
  requestedSchema: o.schema ?? { type: 'object', properties: {} },
  _meta: {
    codex_approval_kind: 'mcp_tool_call',
    connector_id: 'computer-use',
    tool_params: { app: 'Safari' },
    ...(o.persist !== undefined ? { persist: o.persist } : {}),
    ...(o.meta ?? {}),
  },
});

test("Codex's app approval offers what Codex App's card does: Always allow when offered, and Allow this conversation, never once", () => {
  assert.deepEqual(nativeAppApproval(appRequest()), {
    app: 'Safari',
    tool: null,
    title: 'Allow Codex to use Safari?',
    connector: null,
    warning: null,
    risk: null,
    details: [],
    scopes: [{ value: 'session', label: 'Allow this conversation' }],
    lead: 'session',
    unsupported: [],
  });
  assert.deepEqual(
    nativeAppApproval(appRequest({ persist: 'always' }))?.scopes.map((s) => s.value),
    ['session'],
    'persist must be a list',
  );
  assert.deepEqual(
    nativeAppApproval(appRequest({ persist: ['session'] }))?.scopes.map((s) => s.value),
    ['session'],
  );
  const widest = nativeAppApproval(appRequest({ persist: ['always', 'session', 'forever', 7] }));
  assert.deepEqual(widest?.scopes, [
    { value: 'always', label: 'Always allow' },
    { value: 'session', label: 'Allow this conversation' },
  ]);
  // a grant this version can't give is kept, as sent, for the card to name
  assert.deepEqual(widest?.unsupported, ['forever', '7']);
  assert.equal(nativeAppApproval(appRequest({ schema: { type: 'object', properties: {}, required: [] } }))?.app, 'Safari');
});

// What Sky's computer-use policy sends (unified-computer-use on OpenAI's Sky service): its own message,
// connector, risk level, warning subtitle and the app as it displays it.
const skyApproval = (meta: any = {}, message: unknown = 'Allow Computer Use to use "Notes"?') => ({
  ...appRequest(),
  message,
  _meta: {
    codex_approval_kind: 'mcp_tool_call',
    connector_id: 'computer-use',
    connector_name: 'Computer Use',
    persist: ['session', 'always'],
    riskLevel: 'high',
    subtitle: 'Notes can contain private information.',
    tool_name: 'get_app_state',
    tool_params: { app: 'com.apple.Notes' },
    tool_params_display: [{ name: 'app', display_name: 'App', value: 'Notes' }],
    ...meta,
  },
});

test("a Sky app approval keeps the request's own message, connector, risk level, warning and app as sent", () => {
  assert.deepEqual(nativeAppApproval(skyApproval()), {
    app: 'com.apple.Notes',
    tool: 'get_app_state',
    title: 'Allow Computer Use to use "Notes"?',
    connector: 'Computer Use',
    warning: 'Notes can contain private information.',
    risk: 'high',
    details: [{ label: 'App', value: 'Notes' }],
    // Codex App's card for an elevated-risk app: still led by Allow this conversation, and no once
    scopes: [
      { value: 'always', label: 'Always allow' },
      { value: 'session', label: 'Allow this conversation' },
    ],
    lead: 'session',
    unsupported: [],
  });
  // MoPilot's own title only when the request sent no message: the app as it displays it, else its id
  assert.equal(nativeAppApproval(skyApproval({}, '  '))?.title, 'Allow Codex to use Notes?');
  assert.equal(nativeAppApproval(skyApproval({ tool_params_display: undefined }, null))?.title, 'Allow Codex to use com.apple.Notes?');
  // the older warningSubtitle field still reads; subtitle comes first
  assert.equal(nativeAppApproval(skyApproval({ subtitle: undefined, warningSubtitle: 'Old warning' }))?.warning, 'Old warning');
  // a low or missing risk level is no risk note; an unknown level is kept as sent
  assert.equal(nativeAppApproval(skyApproval({ riskLevel: 'Low' }))?.risk, null);
  assert.equal(nativeAppApproval(skyApproval({ riskLevel: undefined }))?.risk, null);
  assert.equal(nativeAppApproval(skyApproval({ riskLevel: 'critical' }))?.risk, 'critical');
  // display entries without a label or a value are skipped; a non-text value reads as JSON
  assert.deepEqual(
    nativeAppApproval(
      skyApproval({
        tool_params_display: [{ name: 'Window', value: 2 }, { display_name: ' ', value: 'x' }, { name: 'none', value: null }, {}, null],
      }),
    )?.details,
    [{ label: 'Window', value: '2' }],
  );
});

test('a Sky request about no app (computer audio) is an approval of its own, by its tool', () => {
  const audio = skyApproval(
    {
      tool_name: 'start_audio_recording',
      tool_params: {},
      tool_params_display: [],
      persist: ['session'],
      subtitle: undefined,
      codex_request_type: 'approval_request',
    },
    'Allow Computer Use to record computer audio?',
  );
  const a = nativeAppApproval(audio)!;
  assert.deepEqual(
    [a.app, a.tool, a.title, a.risk, a.scopes.map((s) => s.value)],
    [null, 'start_audio_recording', 'Allow Computer Use to record computer audio?', 'high', ['once', 'session']],
  );
  // a request about no app keeps its narrowest grant first
  assert.equal(a.lead, 'once');
  assert.equal(nativeAppApproval({ ...audio, message: '' })?.title, 'Allow Codex to record computer audio?');
  // another tool without an app: named by its tool
  assert.equal(
    nativeAppApproval(skyApproval({ tool_name: 'list_apps', tool_params: {} }, null))?.title,
    'Allow Codex Computer Use to run list_apps?',
  );
  assert.deepEqual(nativeAppAnswer(audio, 'session'), { action: 'accept', content: {}, _meta: { persist: 'session' } });
  // without params, or without a tool name, it is not one
  assert.equal(nativeAppApproval(skyApproval({ tool_name: 'start_audio_recording', tool_params: undefined })), null);
  assert.equal(nativeAppApproval(skyApproval({ tool_name: 7, tool_params: {} })), null);
});

test('any other elicitation is not an app approval', () => {
  const not = [
    null,
    {},
    appRequest({ mode: 'url' }),
    appRequest({ schema: { type: 'string', properties: {} } }),
    appRequest({ schema: { type: 'object' } }),
    appRequest({ schema: { type: 'object', properties: 'x' } }),
    appRequest({ schema: { type: 'object', properties: [] } }),
    appRequest({ schema: { type: 'object', properties: { note: { type: 'string' } } } }),
    appRequest({ schema: { type: 'object', properties: {}, required: 'note' } }),
    appRequest({ schema: { type: 'object', properties: {}, required: ['note'] } }),
    appRequest({ meta: { codex_approval_kind: 'other' } }),
    appRequest({ meta: { connector_id: 'browser' } }),
    appRequest({ meta: { tool_params: { app: 7 } } }),
    appRequest({ meta: { tool_params: null } }),
    { ...appRequest(), _meta: undefined },
  ];
  for (const p of not) assert.equal(nativeAppApproval(p), null, JSON.stringify(p));
});

test('an app approval answer puts the chosen grant in _meta.persist and never widens the offer', () => {
  const p = appRequest({ persist: ['session'] });
  // Sky never offers once for an app: not a choice here
  assert.deepEqual(nativeAppAnswer(p, 'once'), { action: 'cancel', content: null, _meta: null });
  assert.deepEqual(nativeAppAnswer(p, 'session'), { action: 'accept', content: {}, _meta: { persist: 'session' } });
  // Allow this conversation on a request that offers no session grant is a plain accept, as Codex App answers it
  assert.deepEqual(nativeAppAnswer(appRequest(), 'session'), { action: 'accept', content: {}, _meta: null });
  assert.deepEqual(nativeAppAnswer(appRequest({ persist: ['always'] }), 'always'), {
    action: 'accept',
    content: {},
    _meta: { persist: 'always' },
  });
  // not offered, or not an app approval: cancel
  assert.deepEqual(nativeAppAnswer(p, 'always'), { action: 'cancel', content: null, _meta: null });
  assert.deepEqual(nativeAppAnswer({ mode: 'form' }, 'session'), { action: 'cancel', content: null, _meta: null });
  assert.deepEqual(nativeAppAnswer(p, 'decline'), { action: 'decline', content: null, _meta: null });
  assert.deepEqual(nativeAppAnswer(p, 'cancel'), { action: 'cancel', content: null, _meta: null });
});

/* ---------- statusStrip ---------- */

test('the strip shows computer control, then native-control cleanup, then approval and tasks', () => {
  assert.equal(pickStrip({}), null);
  assert.equal(pickStrip({ tasks: true }), 'tasks');
  assert.equal(pickStrip({ tasks: true, approval: true }), 'approval');
  assert.equal(pickStrip({ tasks: true, approval: true, nativeCleanup: true }), 'nativeCleanup');
  assert.equal(pickStrip({ nativeCleanup: true, computer: true }), 'computer');
  assert.equal(pickChip({}), null);
  assert.equal(pickChip({ cloud: true, switch: true }), 'switch');
});

test('invalid deltas neither flush pending valid text nor reach the consumer', () => {
  const out: [string, any][] = [];
  const { s, schedule } = manual();
  const stream = createStreamNotifications((m, p) => out.push([m, p]), schedule);
  stream.emit('item/agentMessage/delta', delta('Before'));
  for (const value of [undefined, null, 42, false, [], {}]) stream.emit('item/agentMessage/delta', delta(value));
  assert.deepEqual(out, []);
  assert.equal(s.cancels, 0);
  stream.emit('item/agentMessage/delta', delta('After'));
  s.paint();
  assert.deepEqual(out, [['item/agentMessage/delta', delta('BeforeAfter')]]);
});

test('invalid reasoning indices cannot flush pending text or reach the consumer', () => {
  const out: [string, any][] = [];
  const { s, schedule } = manual();
  const stream = createStreamNotifications((m, p) => out.push([m, p]), schedule);
  stream.emit('item/agentMessage/delta', delta('Before'));
  stream.emit('item/reasoning/summaryTextDelta', { ...delta('bad'), summaryIndex: -1 });
  stream.emit('item/reasoning/summaryPartAdded', { ...delta(''), summaryIndex: 4096 });
  assert.deepEqual(out, []);
  assert.equal(s.cancels, 0);
  s.paint();
  assert.deepEqual(out, [['item/agentMessage/delta', delta('Before')]]);
});
