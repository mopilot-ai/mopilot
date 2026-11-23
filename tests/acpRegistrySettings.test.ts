// Registry and native harness settings preserve managed version ownership through list, selected-page and missing-install states.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { store, OtherHarnesses, harness, rowOf, open, h, render, click, byText, maybeText } from './support/other-harnesses-harness.ts';
import { agent } from './support/acp-registry.ts';

test('list details and the selected Advanced page pass managed ownership only for registry descriptors', async () => {
  for (const descriptor of [undefined, {}, { registry: agent('settings-managed') }]) {
    const id = 'registry-settings-managed';
    store.setState({
      prefs: {},
      basicSignIns: {},
      basicHarnesses: [harness({ id, label: 'Managed', descriptor, bin: '/managed/launch' })],
    });
    const view = await render(h(OtherHarnesses));
    try {
      await open(view.host, id);
      assert.equal(rowOf(view.host, id).querySelector('[data-version-row]')!.getAttribute('data-managed'), String(!!descriptor?.registry));
      await view.rerender(h(OtherHarnesses, { harnessId: id }));
      await click(view.host.querySelector('[data-tab=advanced]'));
      const version = view.host.querySelector('[data-version-row]')!;
      assert.equal(version.getAttribute('data-managed'), String(!!descriptor?.registry));
      assert.equal(version.getAttribute('data-bin'), '/managed/launch');
    } finally {
      await view.unmount();
    }
  }
});

test('a missing registry installation points back to its installer while native harnesses retain manual location recovery', async () => {
  for (const descriptor of [undefined, {}, { registry: agent('settings-missing') }]) {
    const id = 'registry-settings-missing';
    store.setState({ prefs: {}, basicSignIns: {}, basicHarnesses: [harness({ id, label: 'Missing', state: 'missing', descriptor })] });
    const view = await render(h(OtherHarnesses, { harnessId: id }));
    try {
      const managed = !!descriptor?.registry;
      assert.equal(!!maybeText(view.host, 'Set location…'), !managed);
      assert.equal(view.host.textContent!.includes('Install again in Other agents → Agent directory to restore this agent.'), managed);
      if (!managed) {
        await click(byText(view.host, 'Set location…'));
        assert.ok(view.host.querySelector('[data-binpath]'));
      }
    } finally {
      await view.unmount();
    }
  }
});
