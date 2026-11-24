#!/usr/bin/env node
// A resident fake Host that serves the real Host wire (host/src/protocol.mjs: epochs, dedupe, the chat stream, `browser.*`, the tool relay) on a fake Chromium, for the specs of the remote browser (Host work package 2.6).
// It listens on FAKE_HOST_WIRE_SOCK; the fake `ssh` bridges every `host.*` (but the handshake it answers itself), `chat.*` and `browser.*` request to it.
// With FAKE_HOST_DESKTOP=1 it also serves the Host's own desktop (`desktop.*`, G8) over a fake helper; a message "desktop <app>" makes the turn ask for that app and look at the screen (desktop_request_access, desktop_screenshot); "desktop <app> wait" keeps the turn open until Stop; "desktop <app> click wait" also clicks once on the picture.
// Only Chromium, the desktop helper and the chat's model are fake: a message "browse <url>" makes the turn call `browser_navigate` through the Host's registry, so the call goes to the app over the tool relay and the app drives this Host's browser; "browse <url> wait" keeps the
// turn open afterwards until Stop (a tab the user can take over); "browse hang" makes the navigation never answer; any other message is answered with "fake-host: <text>".
// Every request it answers, and every command the fake Chromium receives (as method "cdp"), is appended to FAKE_HOST_LOG (one JSON line) so a spec can read what the Host was asked.
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { createRequire } from 'node:module';
import { createBrowserHost } from '../../../../host/src/browserHost.mjs';
import { createBrowserProtocol } from '../../../../host/src/browserProtocol.mjs';
import { createDesktopHost } from '../../../../host/src/desktopHost.mjs';
import { createDesktopProtocol } from '../../../../host/src/desktopProtocol.mjs';
import { createEpochStore } from '../../../../host/src/epochs.mjs';
import { createGuard } from '../../../../host/src/guard.mjs';
import { createLedger } from '../../../../host/src/ledger.mjs';
import { createProtocol, wireError } from '../../../../host/src/protocol.mjs';
import { hostStatus } from '../../../../host/src/status.mjs';
import { createToolRelay } from '../../../../host/src/toolRelay.mjs';
import { FakeChromium } from '../../../support/fake-chromium.ts';

const require = createRequire(import.meta.url);
const { Registry } = require('../../../../electron/capabilities/contract/registry.cjs');

const sock = process.env.FAKE_HOST_WIRE_SOCK;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'host-wire-'));
const quiet = { report: () => undefined };
const note = (method, params) =>
  process.env.FAKE_HOST_LOG && fs.appendFileSync(process.env.FAKE_HOST_LOG, `${JSON.stringify({ method, params })}\n`);

/** A solid grey PNG of the page's size, so the pane's picture has a real size to click on (a browser sniffs the type from the bytes, so the pane's `data:image/jpeg` label still decodes). */
function solidPng(width, height) {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (buf) => {
    let c = 0xffffffff;
    for (const byte of buf) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, data) => {
    const body = Buffer.concat([Buffer.from(type), data]);
    const out = Buffer.alloc(8 + data.length + 4);
    out.writeUInt32BE(data.length, 0);
    body.copy(out, 4);
    out.writeUInt32BE(crc(body), 8 + data.length);
    return out;
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 2, 0, 0, 0], 8); // 8-bit RGB
  const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(width * 3, 0xc8)]);
  const raw = Buffer.concat(Array.from({ length: height }, () => row));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]).toString('base64');
}
const IMAGE = solidPng(800, 600);

// the Host's browser: the real service, on a Chromium that answers like one
const chromium = new FakeChromium();
chromium.results.set('Page.captureScreenshot', { data: IMAGE });
chromium.ops.tree = () => ({ lines: ['- heading "Pane page" [level=1] [ref_1]', '- button "Go" [ref_2]'], truncated: false });
const send = chromium.pipe.send;
chromium.pipe.send = (m) => {
  note('cdp', { method: m.method, sessionId: m.sessionId ?? '' });
  return send(m);
};
const browser = createBrowserHost({
  launch: chromium.launch,
  downloadsDir: path.join(dir, 'downloads'),
  idleMs: 30 * 60_000,
  graceMs: 60_000,
});

const epochs = createEpochStore(path.join(dir, 'epochs.json'), quiet);
const guard = createGuard({ epochs, ledger: createLedger(path.join(dir, 'ledger'), quiet) });
const registry = new Registry();
const tools = createToolRelay({ registry });

// the Host's own desktop (G8): the real lease, grants and call-id code over a helper that answers like one and records what it was asked (method "desktop.helper"); only the helper is fake
const NOTES = { pid: 4242, bundleId: 'com.apple.Notes', name: 'Notes' };
const desktop = createDesktopHost({
  helper: {
    installed: true,
    running: true,
    generation: 1,
    stop() {},
    async call(method, params) {
      note('desktop.helper', { method, params });
      if (method === 'apps.resolve')
        return {
          apps: params.queries.map((q) => ({ query: q, app: String(q).toLowerCase() === 'notes' ? { ...NOTES, running: true } : null })),
        };
      if (method === 'screenshot')
        return {
          png: IMAGE,
          width: 800,
          height: 600,
          pixelsPerPoint: 1,
          display: { id: 1, x: 0, y: 0, width: 800, height: 600 },
          mimeType: 'image/png',
        };
      if (method === 'target.info') return NOTES;
      return { ok: true };
    },
  },
  probe: { ok: () => true, why: () => '', recheck() {} },
  epochOf: (chatId) => epochs.current(chatId),
  maxReply: 6 * 1024 * 1024,
});

/** The turns that wait for Stop: chat id -> end it. @type {Map<string, () => void>} */
const waiting = new Map();
/** The tool call each chat has under way, so Stop can end it. @type {Map<string, AbortController>} */
const calls = new Map();
let turns = 0;
const runtimeEvents = new EventEmitter();
const emit = (e) => runtimeEvents.emit('event', e);
const say = (key, turnId, text) =>
  emit({ kind: 'update', turnId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } } });

async function run(key, turnId, text) {
  const end = (stopReason) => {
    waiting.delete(key);
    emit({ kind: 'turnEnd', turnId, stopReason });
  };
  if (text === 'use this Mac' || text === 'open Notes on this Mac') {
    const mac = (tool, args = {}) => registry.invoke(key, 'seg1', 'this_mac_control', { action: 'call', tool, arguments: args });
    let result = await mac('desktop_list_granted_applications');
    if (result.ok && text === 'open Notes on this Mac') {
      result = await mac('desktop_request_access', { apps: ['Notes'], reason: 'Open Notes in the test.' });
      if (result.ok) result = await mac('desktop_open_application', { app: 'Notes' });
    }
    say(key, turnId, `fake-host: this Mac ${result.ok ? 'ok' : result.error.code}`);
    return end('end_turn');
  }
  // "desktop <app>": the model asks for the app and looks at the Host's desktop, through the tool relay like any other tool
  const looks = /^desktop (\S+)(?: (click))?(?: (wait))?/.exec(text);
  if (looks) {
    await new Promise((resolve) => setTimeout(resolve, 300));
    const access = await registry.invoke(key, 'seg1', 'desktop_request_access', { apps: [looks[1]], reason: 'e2e' });
    const shot = access.ok ? await registry.invoke(key, 'seg1', 'desktop_screenshot', {}) : access;
    say(key, turnId, `fake-host: desktop ${shot.ok ? 'ok' : `${shot.error.code} ${shot.error.message ?? ''}`}`);
    if (shot.ok && looks[2]) {
      // "desktop <app> click": one click on the picture, through the same relay (the pane draws the agent's cursor for it)
      const click = await registry.invoke(key, 'seg1', 'desktop_left_click', { coordinate: [200, 150] });
      say(key, turnId, `fake-host: click ${click.ok ? 'ok' : `${click.error.code} ${click.error.message ?? ''}`}`);
    }
    if (!looks[3] || !shot.ok) return end('end_turn');
    // the turn stays open, and the desktop stays the agent's, until the user stops it
    await new Promise((resolve) => waiting.set(key, resolve));
    return end('cancelled');
  }
  // "computer click": the model tries the older Mac-only tool, which a Host's chat is never offered
  if (text === 'computer click') {
    const res = await registry.invoke(key, 'seg1', 'computer_click', { x: 1, y: 1 });
    say(key, turnId, `fake-host: computer ${res.ok ? 'ok' : `${res.error.code} ${res.error.message ?? ''}`}`);
    return end('end_turn');
  }
  const browse = /^browse (\S+)(?: (wait))?/.exec(text);
  if (!browse) {
    say(key, turnId, `fake-host: ${text}`);
    return end('end_turn');
  }
  // a model takes a moment to ask for a tool: the Host marks the app that owns the chat once the send that started the turn has returned
  await new Promise((resolve) => setTimeout(resolve, 300));
  if (browse[1] === 'hang') chromium.hangs.add('Page.navigate');
  const ac = new AbortController();
  calls.set(key, ac);
  const result = await registry.invoke(
    key,
    'seg1',
    'browser_navigate',
    { url: browse[1] === 'hang' ? 'http://pane.test/hang' : browse[1] },
    { signal: ac.signal },
  );
  calls.delete(key);
  chromium.hangs.clear();
  if (!result.ok) {
    say(key, turnId, `fake-host: browser failed (${result.error.code})`);
    return end(result.error.code === 'aborted' ? 'cancelled' : 'end_turn');
  }
  say(
    key,
    turnId,
    `fake-host: browsed ${result.content
      .map((b) => b.text ?? '')
      .join(' ')
      .slice(0, 200)}`,
  );
  if (!browse[2]) return end('end_turn');
  // the turn stays open, and the page stays the agent's, until the user stops it
  await new Promise((resolve) => waiting.set(key, resolve));
  end('cancelled');
}

const runtime = {
  host: Object.assign(runtimeEvents, {
    cancel(key) {
      calls.get(key)?.abort();
      waiting.get(key)?.();
    },
  }),
  async send({ key, text, human }) {
    const turnId = `t${++turns}`;
    emit({
      kind: 'turnStart',
      key,
      turnId,
      // as a Host does: the turn says a person wrote the message only when the request said so
      ...(human === true ? { human: true } : {}),
      user: { id: `u-${turnId}`, clientId: turnId, content: [{ type: 'text', text, text_elements: [] }] },
    });
    void run(key, turnId, text).catch((error) => {
      say(key, turnId, `fake-host: failed (${error?.message})`);
      emit({ kind: 'turnEnd', turnId, stopReason: 'end_turn' });
    });
    return { turnId };
  },
  permit: () => false,
};

const protocol = createProtocol({
  runtime,
  epochs,
  guard,
  status: () =>
    hostStatus({
      running: true,
      harnesses: [{ id: 'kimi', detected: true, signedIn: true }],
      browser: true,
      desktop: process.env.FAKE_HOST_DESKTOP === '1',
    }),
  browser: createBrowserProtocol({ browser, epochs }),
  desktop: createDesktopProtocol({ desktop, epochs }),
  tools,
});

fs.rmSync(sock, { force: true });
net
  .createServer((socket) => {
    let buffer = '';
    const write = (m) => socket.writable && socket.write(`${JSON.stringify(m)}\n`);
    const conn = protocol.connection(write);
    socket.setEncoding('utf8');
    socket.on('error', () => socket.destroy());
    socket.on('close', () => conn.close());
    socket.on('data', (chunk) => {
      buffer += chunk;
      for (let i = buffer.indexOf('\n'); i >= 0; i = buffer.indexOf('\n')) {
        const req = JSON.parse(buffer.slice(0, i));
        buffer = buffer.slice(i + 1);
        if (!req.method.startsWith('browser.') || req.method === 'browser.open' || req.method === 'browser.abort')
          note(req.method, req.params);
        conn
          .call(req.method, req.params)
          .then((result) => write({ id: req.id, result }))
          .catch((error) => write({ id: req.id, ...wireError(error) }));
      }
    });
  })
  .listen(sock);
setInterval(() => undefined, 1 << 30);
