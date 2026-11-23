// The Claude state's Remote Control file, network check and wake listener: in userData, Electron's net and powerMonitor where
// there is an app, and nowhere (memory only, always online, never woken) where there is none.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createState } = require('../electron/harness/claude/state.cjs');

test('without an Electron app there is no file for the Remote Control choices', () => {
  assert.equal(createState().remoteFile(), null);
});

test('without Electron the network is taken as up', () => {
  assert.equal(createState().online(), true);
});

test('without Electron there is no wake to listen for', () => {
  assert.equal(
    createState().onResume(() => {}),
    undefined,
  );
});

test("with Electron's powerMonitor the listener hears each wake until it is stopped", () => {
  const heard = new Set<() => void>();
  const powerMonitor = {
    on: (_e: string, fn: () => void) => heard.add(fn),
    removeListener: (_e: string, fn: () => void) => heard.delete(fn),
  };
  // state.cjs reads Electron once, through the port: load a copy of it that finds one
  const portPath = require.resolve('../electron/platform/ports/electronApi.cjs');
  const statePath = require.resolve('../electron/harness/claude/state.cjs');
  const [port, state] = [require.cache[portPath], require.cache[statePath]];
  require.cache[portPath] = { id: portPath, filename: portPath, loaded: true, exports: { electron: { powerMonitor } } } as any;
  delete require.cache[statePath];
  try {
    let n = 0;
    const stop = require('../electron/harness/claude/state.cjs')
      .createState()
      .onResume(() => n++);
    assert.equal(heard.size, 1);
    [...heard][0]();
    assert.equal(n, 1);
    stop!();
    assert.equal(heard.size, 0);
  } finally {
    require.cache[portPath] = port;
    require.cache[statePath] = state;
  }
});
