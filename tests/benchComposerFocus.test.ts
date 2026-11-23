// Native bench focus recovery must reach the actual composer below old AX depth limits.
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';

const leaf = () => {
  let focused = false;
  return {
    role: () => 'AXTextArea',
    enabled: () => true,
    uiElements: () => [],
    get focused() {
      return () => focused;
    },
    set focused(v: any) {
      focused = v;
    },
  };
};
const deep = (node: any, depth: number) => {
  for (let i = 0; i < depth; i++) {
    const child = node;
    node = { role: () => 'AXGroup', uiElements: () => [child] };
  }
  return node;
};
let roots: any[] = [];
mock.module('node:child_process', {
  exports: {
    execFileSync(_cmd: string, _args: string[], options: { input?: string }) {
      if (!options.input) return '';
      return vm.runInNewContext(options.input + ';run()', {
        Application: () => ({ processes: { byName: () => ({ windows: () => roots }) } }),
      });
    },
  },
});
const { focusTextArea } = await import('../bench/drivers/gui.mjs');

test('native recovery focuses a composer at depth 34, as in Claude Desktop', () => {
  const prompt = leaf();
  roots = [deep(prompt, 34)];
  assert.equal(focusTextArea('Claude'), true);
  assert.equal(prompt.focused(), true);
});

const { focusTextAreaTree, focusTextAreaScript } = await import('../bench/lib/composerFocus.mjs');

test('empty or exhausted traversal reports no focus, including cyclic AX data', () => {
  assert.equal(focusTextAreaTree([]), 'none');
  const cycle: any = { role: () => 'AXGroup', uiElements: () => [cycle] };
  assert.equal(focusTextAreaTree([cycle], 3), 'none');
  const prompt = leaf();
  assert.equal(focusTextAreaTree([prompt], 0), 'none');
  assert.equal(prompt.focused(), false);
});

test('failed focus, disabled and stale elements do not prevent a later successful retry', () => {
  const ignored = leaf();
  Object.defineProperty(ignored, 'focused', { get: () => () => false, set: () => {} });
  const disabled = { ...leaf(), enabled: () => false };
  const stale = {
    role() {
      throw new Error('retired');
    },
    uiElements() {
      throw new Error('retired');
    },
  };
  const rejected = leaf();
  Object.defineProperty(rejected, 'focused', {
    get: () => () => false,
    set() {
      throw new Error('rejected');
    },
  });
  const prompt = leaf();
  assert.equal(focusTextAreaTree([ignored, disabled, stale, rejected]), 'none');
  assert.equal(focusTextAreaTree([deep(prompt, 34)]), 'ok');
  assert.equal(prompt.focused(), true);
});

test('depth-first order and serialized app identity survive quotes and backslashes', () => {
  const first = leaf(),
    second = leaf();
  assert.equal(focusTextAreaTree([{ role: () => 'AXGroup', uiElements: () => [first, second] }]), 'ok');
  assert.equal(first.focused(), true);
  assert.equal(second.focused(), false);
  const app = 'Claude "test" \\ session';
  let observed = '';
  const result = vm.runInNewContext(focusTextAreaScript(app) + ';run()', {
    Application: () => ({
      processes: {
        byName: (name: string) => {
          observed = name;
          return { windows: () => [leaf()] };
        },
      },
    }),
  });
  assert.equal(result, 'ok');
  assert.equal(observed, app);
});
