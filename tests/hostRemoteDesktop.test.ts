// A remote Host's own desktop on the app's side (G8 #3903): `desktop.*` under the chat's epoch, refused before anything is sent by a Host that is too old, failures as tool errors, and no way to reach this Mac's desktop instead.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
// @ts-ignore: plain ESM without declarations
import { FEATURES } from '../shared/host/schema.mjs';
import { hostWorld, onlineRemote } from './support/host-wire-kit.ts';

const require = createRequire(import.meta.url);
const { createRemoteDesktop, asToolError } = require('../electron/host/remoteDesktop.cjs');
const { ToolError } = require('../electron/capabilities/contract/registry.cjs');

const withDesktop = () => ({ protocol: { minor: 1, floor: 1 }, features: [...FEATURES] });
const OLD = () => ({ protocol: { minor: 1, floor: 1 }, features: ['epoch', 'dedupe', 'isolation', 'lanes', 'browser'] });

test('the desktop channel sends desktop.* under the chat’s epoch; the schema refuses a malformed one before it is sent', async (t) => {
  const w = hostWorld(t);
  w.net.handlers['host.hello'] = withDesktop;
  const { host } = await onlineRemote(w, {}, { epochOf: (id: string) => (id === 'a' ? 4 : 0) });
  const seen: any[] = [];
  w.net.handlers['desktop.lease'] = (p) => (seen.push(p), { leased: true });
  assert.deepEqual(await host.desktop.request('desktop.lease', { chatId: 'a', apps: ['x.y'], extra: 1 }), { leased: true });
  assert.deepEqual(seen[0], { chatId: 'a', epoch: 4, apps: ['x.y'] });
  const writes = w.net.last.written.length;
  await assert.rejects(host.desktop.request('desktop.lease', { chatId: 'a', apps: ['not a bundle id'] }), (e: any) => e.code === 'invalid');
  await assert.rejects(
    host.desktop.request('desktop.call', { chatId: 'a', callId: 'call-0001', method: 'permissions.request' }),
    (e: any) => e.code === 'invalid',
  );
  assert.equal(w.net.last.written.length, writes);
});

test('a Host without the desktop feature refuses desktop.* before anything is sent, as a missing capability', async (t) => {
  const w = hostWorld(t);
  w.net.handlers['host.hello'] = OLD;
  const { host } = await onlineRemote(w);
  const before = w.net.last.written.length;
  await assert.rejects(
    host.desktop.request('desktop.lease', { chatId: 'a', apps: '*' }),
    (e: any) => e.code === 'feature_missing' && e.missing.includes('desktop'),
  );
  const desk = createRemoteDesktop({ host });
  for (const run of [
    () => desk.lease('a', '*'),
    () => desk.command('a', 'screenshot'),
    () => desk.release('a'),
    () => desk.abort('a'),
    () => desk.state('a'),
  ])
    await assert.rejects(run(), (e: any) => e instanceof ToolError && e.code === 'capability_missing' && /too old/.test(e.message));
  assert.equal(w.net.last.written.length, before, 'nothing went to the Host');
});

test('RemoteDesktop: lease, a call with its own call id (kept for a resend), release, abort and state reach the Host', async (t) => {
  const w = hostWorld(t);
  w.net.handlers['host.hello'] = withDesktop;
  const { host } = await onlineRemote(w, {}, { epochOf: () => 2 });
  const seen: any[] = [];
  for (const m of ['desktop.lease', 'desktop.call', 'desktop.release', 'desktop.abort', 'desktop.state'])
    w.net.handlers[m] = (p) => (seen.push([m, p]), { ok: m });
  const desk = createRemoteDesktop({ host });
  assert.equal(desk.alive(), true);
  await desk.lease('c', ['a.b']);
  await desk.command('c', 'input.click', { x: 1, y: 2 });
  await desk.command('c', 'screenshot');
  await desk.command('c', 'input.click', { x: 1, y: 2 }, { callId: 'resend-0001' });
  await desk.release('c');
  await desk.abort('c');
  await desk.state('c');
  assert.deepEqual(
    seen.map(([m]) => m),
    ['desktop.lease', 'desktop.call', 'desktop.call', 'desktop.call', 'desktop.release', 'desktop.abort', 'desktop.state'],
  );
  assert.ok(seen.every(([, p]) => p.chatId === 'c' && p.epoch === 2));
  const ids = seen.filter(([m]) => m === 'desktop.call').map(([, p]) => p.callId);
  assert.equal(new Set(ids).size, 3, 'a call id of its own for each call');
  assert.equal(ids[2], 'resend-0001', 'the caller’s id when it resends');
  assert.deepEqual(seen[1][1].params, { x: 1, y: 2 });
  assert.deepEqual(seen[2][1].params, {});
});

test('failures reach the tool layer with the Host’s code: busy, unavailable, an unreachable Host is not_connected; an unreadable failure is failed', async (t) => {
  const w = hostWorld(t);
  w.net.handlers['host.hello'] = withDesktop;
  const { host } = await onlineRemote(w);
  const desk = createRemoteDesktop({ host });
  w.net.raw['desktop.lease'] = (id: number) => ({ id, error: "Another chat is using this Host's desktop.", code: 'busy' });
  await assert.rejects(desk.lease('c', '*'), (e: any) => e instanceof ToolError && e.code === 'busy' && /Another chat/.test(e.message));
  w.net.raw['desktop.state'] = (id: number) => ({ id, error: 'The desktop helper is not installed on this Host.', code: 'unavailable' });
  await assert.rejects(desk.state('c'), (e: any) => e.code === 'unavailable');
  assert.equal(asToolError(new ToolError('x', 'busy')).code, 'busy');
  assert.equal(asToolError(Object.assign(new Error('The host is unreachable: down'), { code: 'host_unreachable' })).code, 'not_connected');
  assert.equal(asToolError(Object.assign(new Error('nope'), { code: 'unsupported' })).code, 'capability_missing');
  assert.equal(
    asToolError(Object.assign(new Error(), { code: 'host_unreachable', message: undefined })).message,
    'The host is unreachable.',
  );
  assert.equal(asToolError(new Error('plain')).code, 'failed');
  assert.equal(asToolError('text').message, 'text');
  assert.equal(asToolError(undefined).message, 'undefined');
});

test('a Host that is down is not_connected and nothing else answers for it: the transport has no local desktop to fall back to', async (t) => {
  const w = hostWorld(t);
  w.net.handlers['host.hello'] = withDesktop;
  const { host } = await onlineRemote(w);
  const desk = createRemoteDesktop({ host });
  w.net.mode = 'refuse';
  host.dispose();
  await assert.rejects(desk.command('c', 'screenshot'), (e: any) => e instanceof ToolError);
  assert.equal(desk.alive(), false);
  // the module holds no helper, grant store or desktop control of this Mac
  const source = require('node:fs').readFileSync(require.resolve('../electron/host/remoteDesktop.cjs'), 'utf8');
  assert.doesNotMatch(source, /computer\.cjs|ComputerHelper|DesktopControl|computerUse/);
});
