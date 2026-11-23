// Existing Stop and Duplicate recovery UI exercise both guest and view boundaries with the recording pane fixture.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup, fixture, click, emit, container } from './support/browser-panel-ui/fixture.ts';

test('a restoring duplicate mounts a blank independent guest in its captured partition and shows retry failure inline', async () => {
  await setup({
    tab: { restoring: true, browserPartition: 'partition-source', duplicateError: 'Could not duplicate this tab. Try again.' },
  });
  assert.equal(fixture.guest.getAttribute('src'), 'about:blank');
  assert.equal(fixture.guest.getAttribute('partition'), 'partition-source');
  assert.match(container.querySelector('[role=alert]')!.textContent!, /Could not duplicate/);
  await click('Retry Duplicate');
  assert.ok(fixture.calls.some((call: any[]) => call[0] === 'duplicate' && call[1] === 'tab'));
  // the notice closes like every other: the tab's error is cleared, nothing is retried
  await click('Close');
  assert.deepEqual(fixture.calls.at(-1), ['dismissDuplicateError', 'tab']);
});

test('the existing Stop routes through main and reports refusal instead of silently ignoring it', async () => {
  await setup({
    handlers: {
      stopLoading: async () => {
        throw new Error('refused');
      },
    },
  });
  fixture.loading = true;
  await emit('did-start-loading');
  await click('Stop');
  assert.ok(fixture.calls.some((call: any[]) => call[0] === 'stopLoading' && call[1] === 10));
  assert.match(container.textContent!, /not ready yet/);
});

test('a reserved duplicate uses its main-owned view even when the ordinary browser uses guests', async () => {
  await setup({
    tab: { browserView: true, restoring: true, browserPartition: 'partition-source' },
    handlers: {
      'view.bind': async () => ({ id: 10, state: { url: '', title: '', canGoBack: false, canGoForward: false, loading: false, zoom: 1 } }),
      'view.bounds': async () => true,
    },
  });
  assert.equal(container.querySelector('webview'), null);
  assert.ok(container.querySelector('.browser-bar')!.hasAttribute('inert'));
  assert.ok(fixture.calls.some((call: any[]) => call[0] === 'view.bind' && call[2].url === 'about:blank'));
});
