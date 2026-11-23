// The packaged picker helper follows real draft transitions and selects each harness's own model flyout.
import {
  test,
  assert,
  $,
  click,
  fire,
  mount,
  store,
  fx,
  createElement,
  ModelPicker,
  last,
  events,
} from './support/harness-picker-ui/fixture.ts';
import { pickHarness } from './packaged/harness-picker.mjs';

// Only Playwright's transport is adapted; selectors and clicks act on the production React components.
class Locator {
  private read: () => Element[];
  constructor(read: () => Element[]) {
    this.read = read;
  }
  locator(selector: string, options: { hasText?: string } = {}) {
    return new Locator(() =>
      this.read()
        .flatMap((el) => [...el.querySelectorAll(selector)])
        .filter((el) => !options.hasText || el.textContent!.includes(options.hasText)),
    );
  }
  getByRole(role: string, { name, exact = false }: { name: string; exact?: boolean }) {
    return new Locator(() =>
      this.read()
        .flatMap((el) => [...el.querySelectorAll(role === 'button' ? 'button, [role="button"]' : `[role="${role}"]`)])
        .filter((el) => {
          const label = (el.getAttribute('aria-label') ?? el.textContent ?? '').trim().replace(/\s+/g, ' ');
          return exact ? label === name : label.toLowerCase().includes(name.toLowerCase());
        }),
    );
  }
  async click() {
    const elements = this.read();
    assert.equal(elements.length, 1, 'the packaged locator must resolve one real UI element');
    await click(elements[0] as HTMLElement);
  }
  async getAttribute(name: string) {
    const elements = this.read();
    assert.equal(elements.length, 1, 'the packaged attribute read must resolve one real UI element');
    return elements[0].getAttribute(name);
  }
  async waitFor({ state }: { state: 'detached' }) {
    assert.equal(state, 'detached');
    assert.equal(this.read().length, 0, 'the previous ACP picker must retire before the native picker opens');
  }
}
const page = {
  locator: (selector: string, options?: { hasText?: string }) => new Locator(() => [document.body]).locator(selector, options),
  getByRole: (role: string, options: { name: string; exact?: boolean }) => new Locator(() => [document.body]).getByRole(role, options),
  keyboard: { press: (key: string) => fire(document.body, new window.KeyboardEvent('keydown', { key, bubbles: true })) },
};

for (const basic of [false, true])
  test(`packaged selection from a ${basic ? 'basic' : 'native'} draft follows each harness's own model flyout`, async () => {
    fx.followDraftPick = true;
    // An exact model choice must not also match a longer label in the same flyout.
    for (const h of ['codex', 'claude']) fx.models[h] = [...fx.models[h], { ...fx.models[h][1], id: 'new-extra', label: 'New extra' }];
    store.set({ newBasic: basic ? 'kimi' : null, basicHarnesses: [{ id: 'kimi', state: 'admitted' }] });
    const mounted = await mount(createElement(ModelPicker, { threadId: null }));
    try {
      let current = basic ? 'acp:kimi' : 'codex';
      for (const [label, kind, model] of [
        ['Codex', 'codex', 'New'],
        ['Claude Code', 'claude', 'New'],
        ['Kimi', 'acp:kimi', null],
        ['Codex', 'codex', 'Old'],
        ['Codex', 'codex', 'New'],
      ] as const) {
        const before = events.length;
        await pickHarness(page, label, model);
        const picked = events.slice(before);
        // A draft already on this harness changes only model; every actual switch belongs to this draft.
        assert.deepEqual(
          picked.find((event) => event[0] === 'pick'),
          current !== kind ? ['pick', kind] : undefined,
        );
        current = kind;
        if (model) {
          const selection = picked.find((event) => event[0] === 'selection');
          assert.equal(selection?.[1], kind);
          assert.equal(selection?.[2].model, model.toLowerCase());
          assert.equal(selection?.[2].effort, 'high');
          assert.equal(selection?.[3], null);
        }
        assert.equal($('.popover-layer'), null, 'Escape closes the returned effort pane before the next selection');
      }
      assert.equal(fx.models.codex[1].label, fx.models.claude[1].label, 'equal labels must remain scoped to their harness');
      assert.equal(last('chooseAccount'), undefined, 'a harness header must not be treated as model selection');
    } finally {
      await mounted.unmount();
    }
  });

test('a missing packaged model is refused without a selection, and a closed picker can retry', async () => {
  fx.followDraftPick = true;
  const mounted = await mount(createElement(ModelPicker, { threadId: null }));
  try {
    await assert.rejects(pickHarness(page, 'Codex', 'Absent'), /must resolve one real UI element/);
    assert.equal(last('selection'), undefined);
    await page.keyboard.press('Escape');
    await pickHarness(page, 'Claude Code', 'New');
    assert.equal(last('selection')?.[1], 'claude');
    assert.equal(last('selection')?.[2].model, 'new');
    assert.equal($('.popover-layer'), null);
  } finally {
    await mounted.unmount();
  }
});
