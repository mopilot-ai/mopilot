// The legacy guest pane restores local previews with cancellation, failure retry and replacement ownership.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup, fixture, container, act, click, rerender, change, submit, emit } from './support/browser-panel-ui/fixture.ts';
import { deferred } from './support/async-scenarios.ts';
const url = 'http://127.0.0.1:4317/';

test('legacy address, history and reload controls route through main navigation ownership', async () => {
  await setup();
  await emit('dom-ready');
  await change('.browser-addr input', 'https://newer.test/');
  await submit();
  await click('Back');
  await click('Forward');
  await click('Reload');
  assert.deepEqual(
    fixture.calls.filter((c: any) => c[0] === 'navigateGuest'),
    [
      ['navigateGuest', 10, 'loadURL', 'https://newer.test/'],
      ['navigateGuest', 10, 'goBack', undefined],
      ['navigateGuest', 10, 'goForward', undefined],
      ['navigateGuest', 10, 'reload', undefined],
    ],
  );
});

test('a failed legacy history or reload request leaves a visible retryable page notice', async () => {
  await setup({
    handlers: {
      navigateGuest: async () => {
        throw new Error('page gone');
      },
    },
  });
  await emit('dom-ready');
  await click('Back');
  assert.match(container.textContent ?? '', /page is not ready/);
});

test('a legacy local pane waits for its ready URL and keeps ordinary pages synchronous', async () => {
  const ready = deferred<string>();
  await setup({ tab: { url }, handlers: { preparePreview: () => ready.promise } });
  assert.equal(container.querySelector('webview'), null);
  assert.equal(container.querySelector('.browser-loadbar')?.getAttribute('data-on'), 'true');
  assert.ok(fixture.calls.some((c: any) => c[0] === 'preparePreview' && c[1] === 'agent-chat' && c[2] === url));
  await act(async () => ready.resolve('http://127.0.0.1:4318/'));
  assert.equal(container.querySelector('webview')?.getAttribute('src'), 'http://127.0.0.1:4318/');
});

test('a legacy preview failure offers Retry and opens the eventual ready page', async () => {
  await setup({
    tab: { url },
    handlers: {
      preparePreview: async () => {
        throw new Error('server failed');
      },
    },
  });
  assert.match(container.textContent ?? '', /preview server could not restart/);
  assert.equal(container.querySelector('webview'), null);
  fixture.nativeHandlers.preparePreview = async () => url;
  await click('Retry');
  assert.equal(container.querySelector('webview')?.getAttribute('src'), url);
  assert.doesNotMatch(container.textContent ?? '', /preview server could not restart/);
});

for (const result of ['success', 'failure'] as const) {
  test(`Stop prevents a late legacy preview ${result} from reopening the guest`, async () => {
    const ready = deferred<string>();
    await setup({ tab: { url }, handlers: { preparePreview: () => ready.promise } });
    await click('Stop');
    await act(async () => (result === 'success' ? ready.resolve(url) : ready.reject(new Error('late'))));
    assert.equal(container.querySelector('webview'), null);
    assert.match(container.textContent ?? '', /preview load was stopped/);
    fixture.nativeHandlers.preparePreview = async () => url;
    await click('Retry');
    assert.equal(container.querySelector('webview')?.getAttribute('src'), url);
  });
}

test('replacing the legacy pane owner rejects the old result while the new owner stays pending', async () => {
  const old = deferred<string>(),
    replacement = deferred<string>();
  await setup({
    tab: { url },
    handlers: { preparePreview: (chat: string) => (chat === 'agent-chat' ? old.promise : replacement.promise) },
  });
  await act(async () => fixture.update({ paneTabs: [{ ...fixture.state.paneTabs[0], agentChat: 'new-chat' }] }));
  await rerender();
  await act(async () => old.resolve(url));
  assert.equal(container.querySelector('webview'), null);
  await act(async () => replacement.resolve('http://127.0.0.1:4318/'));
  assert.equal(container.querySelector('webview')?.getAttribute('src'), 'http://127.0.0.1:4318/');
});
