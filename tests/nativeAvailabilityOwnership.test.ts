// Native status and Chrome-link snapshots keep latest-read and effect-generation ownership.
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { window } from './support/dom.ts';
import { controlledReads } from './support/async-scenarios.ts';
import { installNativeStub } from './support/ports/native.ts';

const { act, createElement, StrictMode } = await import('react');
const { createRoot } = await import('react-dom/client');
const f = {
  status: controlledReads<any>(),
  links: controlledReads<any>(),
  probes: [] as [string, boolean][],
  errors: [] as [string, unknown][],
  listeners: { status: [] as (() => void)[], channel: [] as (() => void)[], links: [] as (() => void)[] },
};
const subscribe = (key: keyof typeof f.listeners, callback: () => void) => {
  f.listeners[key].push(callback);
  // Keep the queued callback accessible after unsubscribe, as IPC delivery can already have queued it.
  return () => {};
};
installNativeStub({
  availability: {
    status: (again: boolean) => {
      f.probes.push(['status', again]);
      return f.status.read();
    },
    chromeLinks: (again: boolean) => {
      f.probes.push(['links', again]);
      return f.links.read();
    },
    onChanged: (callback: () => void) => subscribe('status', callback),
    onChromeLinksChanged: (callback: () => void) => subscribe('links', callback),
  },
  browser: { onChannelChanged: (callback: () => void) => subscribe('channel', callback) },
});
mock.module('../src/lib/ignored.ts', {
  namedExports: { ignoring: (what: string) => (error: unknown) => f.errors.push([what, error]) },
});
mock.module('../src/harness/family.ts', { namedExports: { HARNESS_TRAITS: {} } });
const { useNativeAvailability, useChromeLinks } = await import('../src/session/nativeAvailability.ts');

function reset() {
  f.status = controlledReads();
  f.links = controlledReads();
  f.probes = [];
  f.errors = [];
  f.listeners = { status: [], channel: [], links: [] };
}
const flush = (action: () => void = () => {}) =>
  act(async () => {
    action();
    await Promise.resolve();
  });
async function mount(kind: 'status' | 'links', enabled = true, strict = false) {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host as any);
  const seen: unknown[] = [];
  function Status({ on }: { on: boolean }) {
    const value = useNativeAvailability(on);
    seen.push(value);
    return createElement('span', null, JSON.stringify(value));
  }
  function Links({ on }: { on: boolean }) {
    const value = useChromeLinks(on);
    seen.push(value);
    return createElement('span', null, JSON.stringify(value));
  }
  const render = (on: boolean) =>
    flush(() => {
      const child = createElement(kind === 'status' ? Status : Links, { on });
      root.render(strict ? createElement(StrictMode, null, child) : child);
    });
  await render(enabled);
  return {
    seen,
    value: () => JSON.parse(host.textContent!),
    render,
    close: async () => {
      await flush(() => root.unmount());
      host.remove();
    },
  };
}

for (const kind of ['status', 'links'] as const) {
  for (const olderFirst of [true, false]) {
    test(`${kind}: overlapping reads publish only the newest snapshot, older first ${olderFirst}`, async () => {
      reset();
      const m = await mount(kind);
      try {
        await flush(() => f.listeners[kind][0]());
        const [old, latest] = f[kind].requests;
        if (olderFirst) {
          await flush(() => old.resolve('old'));
          assert.equal(m.value(), null, 'old success must not replace the pending current snapshot');
          await flush(() => latest.resolve('new'));
        } else {
          await flush(() => latest.resolve('new'));
          await flush(() => old.resolve('old'));
        }
        assert.equal(m.value(), 'new');
        assert.deepEqual(
          f.probes,
          [
            [kind, true],
            [kind, false],
          ],
          'only opening the view forces a probe',
        );
      } finally {
        await m.close();
      }
    });
  }

  test(`${kind}: obsolete errors are quiet; current failures retain the snapshot and retry`, async () => {
    reset();
    const m = await mount(kind);
    try {
      await flush(() => f[kind].requests[0].resolve('baseline'));
      await flush(() => f.listeners[kind][0]());
      await flush(() => f.listeners[kind][0]());
      await flush(() => f[kind].requests[2].resolve('current'));
      await flush(() => f[kind].requests[1].reject(new Error('obsolete')));
      assert.equal(m.value(), 'current');
      assert.deepEqual(f.errors, []);
      await flush(() => f.listeners[kind][0]());
      const error = new Error('current failed');
      await flush(() => f[kind].requests[3].reject(error));
      assert.equal(m.value(), 'current');
      assert.equal(f.errors.length, 1);
      assert.equal(f.errors[0][1], error);
      await flush(() => f.listeners[kind][0]());
      await flush(() => f[kind].requests[4].resolve('retried'));
      assert.equal(m.value(), 'retried');
    } finally {
      await m.close();
    }
  });

  test(`${kind}: cleanup refuses queued reads and retired success/failure publications`, async () => {
    reset();
    const m = await mount(kind);
    await flush(() => f.listeners[kind][0]());
    const retired = f.listeners[kind][0];
    const channel = f.listeners.channel[0];
    await m.close();
    const shown = m.seen.length;
    await flush(() => {
      retired();
      channel?.();
      window.dispatchEvent(new window.Event('focus'));
    });
    assert.equal(f[kind].requests.length, 2, 'queued callbacks after cleanup must not ask main again');
    await flush(() => {
      f[kind].requests[0].resolve('disposed');
      f[kind].requests[1].reject(new Error('disposed error'));
    });
    assert.equal(m.seen.length, shown);
    assert.deepEqual(f.errors, []);
  });

  test(`${kind}: Strict Mode replacement remains pending while retired work settles`, async () => {
    reset();
    const m = await mount(kind, true, true);
    try {
      assert.equal(f[kind].requests.length, 2, 'Strict Mode sets up a replacement effect');
      await flush(() => f.listeners[kind][0]());
      assert.equal(f[kind].requests.length, 2, 'the first effect callback stays retired');
      await flush(() => f[kind].requests[0].reject(new Error('retired Strict Mode read')));
      assert.equal(m.value(), null);
      assert.deepEqual(f.errors, []);
      await flush(() => f[kind].requests[1].resolve('active setup'));
      assert.equal(m.value(), 'active setup');
    } finally {
      await m.close();
    }
  });
}

test('availability: refresh-mode replacement retires old reads and focus/channel events use cached probes', async () => {
  reset();
  const m = await mount('status', false);
  try {
    await m.render(true);
    await flush(() => f.status.requests[0].resolve('retired mode'));
    assert.equal(m.value(), null);
    await flush(() => f.status.requests[1].resolve('new mode'));
    await flush(() => window.dispatchEvent(new window.Event('focus')));
    await flush(() => f.listeners.channel[1]());
    await flush(() => f.status.requests[3].resolve('channel'));
    await flush(() => f.status.requests[2].reject(new Error('old focus')));
    assert.equal(m.value(), 'channel');
    assert.deepEqual(f.errors, []);
    assert.deepEqual(f.probes, [
      ['status', false],
      ['status', true],
      ['status', false],
      ['status', false],
    ]);
  } finally {
    await m.close();
  }
});

test('Chrome links: disabling hides stored links, retires reads and reopening can retry', async () => {
  reset();
  const m = await mount('links', false);
  try {
    assert.equal(f.links.requests.length, 0);
    await m.render(true);
    await flush(() => f.links.requests[0].resolve(['first session']));
    await flush(() => f.listeners.links[0]());
    await m.render(false);
    assert.equal(m.value(), null, 'disabled consumers must not retain a native link summary');
    await flush(() => f.links.requests[1].reject(new Error('disabled read')));
    assert.deepEqual(f.errors, []);
    await m.render(true);
    assert.equal(m.value(), null, 'reopening waits for its own session snapshot');
    await flush(() => f.links.requests[2].resolve(['replacement session']));
    assert.deepEqual(m.value(), ['replacement session']);
  } finally {
    await m.close();
  }
});
