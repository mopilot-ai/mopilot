// The simulator tools on the Registry (electron/capabilities/tools/simulatorTools.cjs): four tools with their schemas,
// each platform's switch, the owning chat, the driver call, and the host-server placement Claude sees them under.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { Registry } = require('../electron/capabilities/contract/registry.cjs');
const { registerSimulatorTools, SPECS } = require('../electron/capabilities/tools/simulatorTools.cjs');
const { placement, HOST_SERVER_NAMES } = require('../electron/capabilities/contract/hostServers.cjs');

function setup(prefs: any = {}) {
  const registry = new Registry();
  const calls: any[] = [];
  const driver = (platform: string) => ({
    control: async (chatId: string, args: any) => (calls.push([platform, 'control', chatId, args]), `${platform} control ${args.action}`),
    logs: async (chatId: string, args: any) => (calls.push([platform, 'logs', chatId, args]), `${platform} logs`),
  });
  const off = registerSimulatorTools(registry, {
    owner: (ctx: any) => (ctx?.segmentId === 'other' ? null : ctx?.chatId),
    prefs: () => prefs,
    drivers: { ios: driver('ios'), android: driver('android') },
  });
  return { registry, calls, off };
}
const call = (registry: any, name: string, args: any, seg = 'seg-1') => registry.invoke('chat-1', seg, name, args);

test('the four tools are registered with their specs and removed together', () => {
  const { registry, off } = setup();
  const names = ['ios_simulator_control', 'ios_simulator_logs', 'android_emulator_control', 'android_emulator_logs'];
  for (const n of names) assert.ok(registry.has(n), n);
  assert.ok(SPECS.android_emulator_control.schema.properties.action.enum.includes('airplane_mode'));
  assert.ok(!SPECS.ios_simulator_control.schema.properties.action.enum.includes('airplane_mode'));
  assert.deepEqual(SPECS.ios_simulator_logs.schema.properties.action.enum, ['read', 'crash_report']);
  off();
  for (const n of names) assert.ok(!registry.has(n), n);
});

test('a call reaches the platform driver as the owning chat', async () => {
  const { registry, calls } = setup();
  assert.match(JSON.stringify(await call(registry, 'ios_simulator_control', { action: 'attach' })), /ios control attach/);
  await call(registry, 'android_emulator_control', { action: 'tap', x: 1, y: 2 });
  await call(registry, 'ios_simulator_logs', {});
  await call(registry, 'android_emulator_logs', { action: 'crash_report' });
  assert.deepEqual(
    calls.map((c) => c.slice(0, 3)),
    [
      ['ios', 'control', 'chat-1'],
      ['android', 'control', 'chat-1'],
      ['ios', 'logs', 'chat-1'],
      ['android', 'logs', 'chat-1'],
    ],
  );
  assert.deepEqual(calls[1][3], { action: 'tap', x: 1, y: 2 });
});

test('each platform has its own switch, and a refusal names it', async () => {
  const { registry, calls } = setup({ simulatorIos: false });
  const ios = await call(registry, 'ios_simulator_control', { action: 'attach' });
  assert.equal(ios.ok, false);
  assert.match(JSON.stringify(ios), /iOS Simulator tools are turned off in Settings/);
  assert.match(JSON.stringify(await call(registry, 'ios_simulator_logs', {})), /turned off/);
  assert.doesNotMatch(JSON.stringify(await call(registry, 'android_emulator_control', { action: 'attach' })), /turned off/);
  const androidOff = setup({ simulatorAndroid: false });
  assert.match(JSON.stringify(await call(androidOff.registry, 'android_emulator_logs', {})), /Android Emulator tools are turned off/);
  assert.deepEqual(
    calls.map((c) => c[0]),
    ['android'],
  );
  assert.equal(androidOff.calls.length, 0);
});

test('a call with no owning chat is refused', async () => {
  const { registry, calls } = setup();
  const r = await call(registry, 'ios_simulator_control', { action: 'attach' }, 'other');
  assert.equal(r.ok, false);
  assert.match(JSON.stringify(r), /does not own this chat segment/);
  assert.equal(calls.length, 0);
  assert.match(JSON.stringify(await call(registry, 'ios_simulator_control', {})), /missing argument: action/);
});

test('without drivers given, the real ones are built on the real runner', () => {
  const registry = new Registry();
  const off = registerSimulatorTools(registry, { owner: () => null, prefs: () => undefined });
  assert.ok(registry.has('ios_simulator_control'));
  off();
});

test('Claude sees them on their own servers as control and logs', () => {
  assert.ok(HOST_SERVER_NAMES.includes('mopilot_ios_simulator'));
  assert.ok(HOST_SERVER_NAMES.includes('mopilot_android_emulator'));
  assert.deepEqual(placement('ios_simulator_control', 'sage_x'), { server: 'mopilot_ios_simulator', name: 'control' });
  assert.deepEqual(placement('ios_simulator_logs', 'sage_x'), { server: 'mopilot_ios_simulator', name: 'logs' });
  assert.deepEqual(placement('android_emulator_control', 'sage_x'), { server: 'mopilot_android_emulator', name: 'control' });
  assert.deepEqual(placement('android_emulator_logs', 'sage_x'), { server: 'mopilot_android_emulator', name: 'logs' });
});
