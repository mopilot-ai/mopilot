// Edge cases of tool sessions, the basic-tier session MCP channel, and the vision backend / OCR merge.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';

const require = createRequire(import.meta.url);
const { ToolSessions, isSageTool } = require('../electron/capabilities/contract/session.cjs');
const { SessionMcp } = require('../electron/capabilities/channels/sessionMcp.cjs');
const { anthropicVision, parsePoint, providerVision } = require('../electron/capabilities/vision/backend.cjs');
const { ocrItems, mergeOcr } = require('../electron/capabilities/vision/ocr.cjs');

test('isSageTool: no server name is never ours; assign on an unknown session does nothing', () => {
  assert.equal(isSageTool('mcp__sage_000000000000__x', undefined), false);
  const s = new ToolSessions();
  s.assign('missing', { chatId: 'c' });
  assert.equal(s.get('missing'), null);
  s.open('k');
  s.assign('k', { chatId: 'c2', harnessPid: undefined });
  assert.equal(s.get('k').chatId, 'c2');
  s.suspend('k');
  s.suspend('k'); // already revoked: no second event
  assert.equal(s.rotate('missing'), null);
});

function channel(admissionMs = 1000) {
  const sessions = new ToolSessions();
  const socket: any = new EventEmitter();
  socket.listen = async () => '/tmp/sock';
  const mcp = new SessionMcp({ sessions, socket, command: 'sage-mcp', admissionMs });
  const events: any[] = [];
  mcp.on('admitted', (e: any) => events.push(['admitted', e.key]));
  mcp.on('admission-failed', (e: any) => events.push(['failed', e.key, e.reason]));
  return { sessions, socket, mcp, events };
}

test('sessionMcp: a resume rotates the token under the same name; a hello while waiting admits', async () => {
  const { sessions, socket, mcp, events } = channel();
  const first = await mcp.prepare('k', { harnessPid: 1 });
  const again = await mcp.prepare('k', { harnessPid: 2, resume: true });
  assert.equal(again.serverName, first.serverName);
  assert.notEqual(again.mcpServers[0].env[1].value, first.mcpServers[0].env[1].value);
  assert.equal(sessions.get('k').harnessPid, 2);
  const p = mcp.admission('k');
  socket.emit('connected', { key: 'k' });
  assert.equal(await p, true);
  assert.deepEqual(events, [['admitted', 'k']]);
});

test('sessionMcp: a second admission supersedes the first quietly; end() withdraws a wait', async () => {
  const { socket, mcp, events } = channel();
  await mcp.prepare('k', {});
  const a = mcp.admission('k');
  const b = mcp.admission('k');
  assert.equal(await a, false);
  // the superseded entry's later hello does nothing to the replaced wait other than resolving b
  mcp.end('k');
  assert.equal(await b, false);
  assert.deepEqual(events, []);
  socket.emit('connected', { key: 'other' });
  assert.equal(mcp.helloed.has('other'), true);
});

test('sessionMcp: switched off, prepare throws and admission is false; the default clock is ten seconds', async () => {
  const sessions = new ToolSessions();
  const socket: any = new EventEmitter();
  socket.listen = async () => '/tmp/sock';
  let on = true;
  const mcp = new SessionMcp({ sessions, socket, command: 'c', enabled: () => on });
  assert.equal(mcp.admissionMs, 10_000);
  await mcp.prepare('k', {});
  on = false;
  await assert.rejects(mcp.prepare('k', {}), /turned off/);
  assert.equal(await mcp.admission('k'), false);
  assert.equal(await mcp.admission('missing'), false);
});

test('sessionMcp: no handshake in time is an admission failure', async () => {
  const { mcp, events } = channel(5);
  await mcp.prepare('k', {});
  assert.equal(await mcp.admission('k'), false);
  assert.deepEqual(events, [['failed', 'k', 'no handshake from sage-mcp within 0s']]);
});

test('sessionMcp: a stale entry finishing after being replaced is ignored', async () => {
  const { mcp } = channel();
  await mcp.prepare('k', {});
  const a = mcp.admission('k');
  const entry = mcp.waiting.get('k');
  const b = mcp.admission('k');
  assert.equal(await a, false);
  entry.done(true); // no longer the waiting entry: nothing happens
  assert.equal(mcp.waiting.has('k'), true);
  mcp.end('k');
  assert.equal(await b, false);
});

test('anthropicVision: the global fetch by default; a reply without content is empty text', async () => {
  assert.equal(typeof anthropicVision({ baseUrl: 'http://x', headers: () => ({}), model: 'm' }), 'function');
  const calls: any[] = [];
  const v = anthropicVision({
    baseUrl: 'http://gw/',
    headers: async () => ({ authorization: 'a' }),
    model: 'm',
    fetch: async (url: string, init: any) => (calls.push([url, init]), { ok: true, json: async () => ({}) }),
  });
  assert.equal(await v({ png: 'p', prompt: 'q' }), '');
  assert.equal(calls[0][0], 'http://gw/v1/messages');
});

test('parsePoint: 0-1 fractions scale to the image; providerVision falls back to the id', () => {
  assert.deepEqual(parsePoint('0.5, 0.25', { width: 200, height: 100 }), { x: 100, y: 25 });
  assert.deepEqual(parsePoint('1, 0.5', { width: 200, height: 100 }), { x: 200, y: 50 });
  assert.deepEqual(providerVision({ id: 'p', visionFallbackModel: 'vm' }, { baseUrl: 'http://x' }), { vendor: 'p', model: 'vm' });
  assert.deepEqual(providerVision({ id: 'p', label: 'P', visionFallbackModel: 'vm' }, { baseUrl: 'http://x' }), {
    vendor: 'P',
    model: 'vm',
  });
});

test('ocr: items come from an elements field too; an untitled AX element does not hide text', () => {
  const res = {
    elements: [
      { text: 'Hello', frame: { x: 0, y: 0, w: 10, h: 10 } },
      { text: 'ax', frame: { x: 0, y: 0, w: 1, h: 1 }, source: 'ax' },
    ],
  };
  assert.equal(ocrItems(res).length, 1);
  assert.deepEqual(ocrItems(null), []);
  assert.equal(ocrItems(res.elements).length, 1);
  const byId = new Map([['a', { frame: { x: 0, y: 0, w: 20, h: 20 } }]]);
  const lines = mergeOcr(byId, res, (p: any) => p);
  assert.deepEqual(lines, ['[ocr-0] Text "Hello" at (5, 5)']);
});
