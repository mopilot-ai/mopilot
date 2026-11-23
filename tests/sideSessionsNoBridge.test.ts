// src/lib/sideSessions.ts: a window with no native bridge (main gone, or a surface that never installs it) reads no
// linked sessions instead of throwing into whatever renders them (#2970: the queue tray reads them on every row).
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import './support/dom.ts';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { useOrchestration, resetSideSessions } from '../src/lib/sideSessions.ts';

let root: ReturnType<typeof createRoot> | null = null;
let host: HTMLElement;
afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = null;
  host?.remove();
  resetSideSessions();
});

test('with no native bridge installed the hook renders the empty view, and a later render still reads it', async () => {
  assert.equal((window as any).native, undefined, 'this test needs a window without the bridge');
  const seen: number[] = [];
  const Probe = () => {
    seen.push(Object.keys(useOrchestration().deliveries).length);
    return null;
  };
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root!.render(createElement(Probe)));
  assert.deepEqual(seen, [0]);
  await act(async () => root!.render(createElement(Probe)));
  assert.ok(seen.length >= 2 && seen.every((n) => n === 0));
});
