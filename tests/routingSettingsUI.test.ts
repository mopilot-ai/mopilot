// Your own provider in Settings: Pay with's choice of a saved model config (BillingRow.tsx), and Accounts & billing's Providers & models
// (ProvidersModels.tsx, lib/routing.ts): a key per provider added, replaced and removed without ever being shown; model configs added,
// edited and removed, with a server of the user's own, Claude family models and fallbacks; refusals toasted with the form kept; a
// file that can't be read says so and changes nothing.
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import './support/dom.ts';
import { settingsExports, render, click, byText, maybeText, type, flush } from './support/pages-kit.ts';
import { installNativeStub } from './support/ports/native.ts';
import { stubStore } from './support/stubs.ts';

const { createElement: h } = await import('react');
const calls: any[] = [];
const provider = (id: string, label: string, o: any = {}) => ({ id, label, wires: ['openai-chat'], baseUrl: null, hasKey: false, ...o });
let providers: any = { providers: [], keys: 'ok' };
let configs: any = { configs: [], invalid: 0, state: 'ok' };
let refuse: string | null = null;
let changed: () => void = () => {};
const answer = async (name: string, ...a: any[]) => {
  calls.push([name, ...a]);
  if (refuse) throw new Error(refuse);
  return true;
};
stubStore({ toast: (...a: any[]) => calls.push(['toast', ...a]) });
installNativeStub({
  routing: {
    providers: async () => providers,
    configs: async () => configs,
    setKey: (...a: any[]) => answer('setKey', ...a),
    clearKey: (...a: any[]) => answer('clearKey', ...a),
    saveConfig: (...a: any[]) => answer('saveConfig', ...a),
    removeConfig: (...a: any[]) => answer('removeConfig', ...a),
    onChanged: (cb: () => void) => ((changed = cb), () => {}),
  },
  mopilot: { signIn: async () => ({ ok: true }) },
});
mock.module('../src/session/open.ts', { namedExports: { openMoPilotPage: () => {} } });
mock.module('../src/components/pages/Settings.tsx', { namedExports: settingsExports });
const { BillingRow } = await import('../src/components/pages/settings/BillingRow.tsx');
const { ProvidersModels } = await import('../src/components/pages/settings/ProvidersModels.tsx');
const { reloadRouting, claudeRoutable } = await import('../src/lib/routing.ts');

const billing = (over: any = {}) => ({
  keys: { placeholder: 'sk', urlPlaceholder: 'https://x', official: 'Anthropic' },
  mode: 'subscription',
  desc: 'd',
  hasKey: true,
  hasSubscription: true,
  onSwitch: async (m: string) => void calls.push(['switch', m]),
  onAddKey: async () => {},
  onRemoveKey: async () => {},
  onSignIn: () => {},
  ...over,
});
const routed = (o: any = {}) => ({
  loaded: true,
  configs: [
    { id: 'c1', name: 'Work' },
    { id: 'c2', name: 'Home' },
  ],
  configId: null,
  onChoose: async (id: string) => void calls.push(['choose', id]),
  ...o,
});

test('Pay with offers Your own provider only where it can run, choosing the config used before or the first saved', async () => {
  let v = await render(h(BillingRow, billing()));
  assert.equal(v.host.querySelector('[data-seg="routed"]'), null);
  await v.unmount();
  v = await render(h(BillingRow, billing({ routed: routed() })));
  calls.length = 0;
  await click(v.host.querySelector('[data-seg="routed"]'));
  assert.deepEqual(calls, [['choose', 'c1']]);
  await v.rerender(h(BillingRow, billing({ routed: routed({ configId: 'c2' }) })));
  calls.length = 0;
  await click(v.host.querySelector('[data-seg="routed"]'));
  assert.deepEqual(calls, [['choose', 'c2']]);
  await v.rerender(h(BillingRow, billing({ routed: routed({ loaded: false, configs: [] }) })));
  calls.length = 0;
  await click(v.host.querySelector('[data-seg="routed"]'));
  assert.deepEqual(
    calls,
    [['toast', 'Your model configs are still being read. Try again in a moment.', 'info']],
    'not "none saved" before they are read',
  );
  await v.rerender(h(BillingRow, billing({ routed: routed({ configs: [] }) })));
  calls.length = 0;
  await click(v.host.querySelector('[data-seg="routed"]'));
  assert.deepEqual(calls, [['toast', 'Save a model config under Providers & models first.', 'info']]);
  await v.unmount();
});

test('while on Your own provider, the row picks among the configs, names one that was removed, and offers no key buttons', async () => {
  const v = await render(h(BillingRow, billing({ mode: 'routed', routed: routed({ configId: 'c1' }) })));
  const select = v.host.querySelector('select') as HTMLSelectElement;
  assert.deepEqual(
    [...select.options].map((o) => o.textContent),
    ['Work', 'Home'],
  );
  assert.equal(maybeText(v.host, 'Remove key'), null);
  assert.equal(maybeText(v.host, 'Replace key'), null);
  calls.length = 0;
  select.value = 'c2';
  select.dispatchEvent(new Event('change', { bubbles: true }));
  await flush();
  assert.deepEqual(calls, [['choose', 'c2']]);
  calls.length = 0;
  select.value = 'c1';
  select.dispatchEvent(new Event('change', { bubbles: true }));
  await flush();
  assert.deepEqual(calls, [], 'the one in use: nothing to do');
  calls.length = 0;
  await click(v.host.querySelector('[data-seg="routed"]'));
  assert.deepEqual(calls, [], 'picking the current mode does nothing');
  await v.rerender(h(BillingRow, billing({ mode: 'routed', routed: routed({ configId: null }) })));
  assert.deepEqual(
    [...(v.host.querySelector('select') as HTMLSelectElement).options].map((o) => o.value),
    ['c1', 'c2', ''],
  );
  await v.rerender(h(BillingRow, billing({ mode: 'routed', routed: routed({ configId: 'gone' }) })));
  assert.deepEqual(
    [...(v.host.querySelector('select') as HTMLSelectElement).options].map((o) => o.textContent),
    ['Work', 'Home', 'Removed config'],
  );
  await v.unmount();
});

const openai = provider('openai', 'OpenAI', { wires: ['openai-chat', 'openai-responses'], hasKey: true });
const catalog = () => ({
  providers: [
    openai,
    provider('anthropic', 'Anthropic', { wires: ['anthropic'] }),
    provider('gemini', 'Google Gemini', { wires: ['gemini'] }),
    provider('deepseek', 'DeepSeek'),
    provider('custom', 'OpenAI-compatible server', { customBase: true, hasKey: null }),
  ],
  keys: 'ok',
});
const work = {
  id: 'c1',
  name: 'Work',
  provider: 'openai',
  model: 'gpt-x',
  tierModels: { haiku: 'gpt-mini' },
  fallbacks: [{ provider: 'deepseek', model: 'deepseek-chat' }],
};

async function page() {
  await reloadRouting();
  const v = await render(h(ProvidersModels));
  await flush();
  return v;
}
const input = (root: ParentNode, label: string) => {
  const field = [...root.querySelectorAll('label.hs-field')].find((l) => l.querySelector('.hs-field-label')?.textContent === label);
  return (field?.querySelector('input') ?? null) as HTMLInputElement | null;
};

test('provider keys: each named provider’s, added, replaced and removed; a key typed is never shown again', async () => {
  providers = catalog();
  configs = { configs: [], invalid: 0, state: 'ok' };
  const v = await page();
  const rows = [...v.host.querySelectorAll('[data-row]')].map((r) => r.getAttribute('data-row'));
  assert.deepEqual(
    rows.slice(0, 4),
    ['OpenAI', 'Anthropic', 'Google Gemini', 'DeepSeek'],
    'not the server of your own: its key is per URL',
  );
  const ds = v.host.querySelector('[data-row="DeepSeek"]')!;
  assert.equal(ds.querySelector('i')!.textContent, 'No key saved');
  await click(byText(ds, 'Add key'));
  await type(ds.querySelector('input[type=password]'), ' sk-ds-1 ');
  calls.length = 0;
  await click(byText(ds, 'Save'));
  assert.deepEqual(calls, [['setKey', 'deepseek', 'sk-ds-1']]);
  assert.equal(ds.querySelector('input'), null, 'the field closes');
  const oa = v.host.querySelector('[data-row="OpenAI"]')!;
  assert.equal(oa.querySelector('i')!.textContent, 'Key saved on this Mac');
  calls.length = 0;
  await click(byText(oa, 'Remove'));
  assert.deepEqual(calls, [['clearKey', 'openai']]);
  await click(byText(oa, 'Replace key'));
  await click(byText(oa, 'Cancel'));
  assert.equal(oa.querySelector('input'), null);
  // a refusal is toasted and the field keeps what was typed
  refuse = 'That is not an API key.';
  await click(byText(ds, 'Add key'));
  await type(ds.querySelector('input[type=password]'), 'nope');
  calls.length = 0;
  await click(byText(ds, 'Save'));
  assert.deepEqual(calls.at(-1), ['toast', 'That is not an API key.', 'error']);
  assert.equal((ds.querySelector('input') as HTMLInputElement).value, 'nope');
  refuse = null;
  await v.unmount();
});

test('model configs: listed with what they send to; added with tier models and fallbacks; edited; removed', async () => {
  providers = catalog();
  configs = { configs: [work], invalid: 0, state: 'ok' };
  const v = await page();
  assert.equal(v.host.querySelector('[data-row="Work"] i')!.textContent, 'OpenAI · gpt-x · then DeepSeek deepseek-chat');
  // a provider the catalog doesn't list (a newer version's) is named by its id
  configs = { configs: [{ ...work, fallbacks: [{ provider: 'mistral', model: 'm' }] }], invalid: 0, state: 'ok' };
  await reloadRouting();
  await flush();
  assert.equal(v.host.querySelector('[data-row="Work"] i')!.textContent, 'OpenAI · gpt-x · then mistral m');
  configs = { configs: [work], invalid: 0, state: 'ok' };
  await reloadRouting();
  await flush();
  calls.length = 0;
  await click(byText(v.host.querySelector('[data-row="Work"]')!, 'Remove'));
  assert.deepEqual(calls, [['removeConfig', 'c1']]);
  // add one
  await click(byText(v.host, 'Add model config'));
  const form = v.host.querySelector('.routing-editor')!;
  assert.deepEqual(
    [...(form.querySelector('select') as HTMLSelectElement).options].map((o) => o.value),
    ['openai', 'anthropic', 'deepseek', 'custom'],
    'only providers a Claude Code request can go to',
  );
  assert.equal((byText(form, 'Save') as HTMLButtonElement).disabled, true, 'a name and a model first');
  await type(input(form, 'Name'), 'Fast');
  await type(input(form, 'Model'), 'gpt-y');
  await type(input(form, 'Haiku model (optional)'), 'gpt-mini');
  await type(input(form, 'Opus model (optional)'), '  ');
  await click(byText(form, 'Add a fallback', 'button'));
  await click(byText(form, 'Add a fallback', 'button'));
  const fallbackSelect = form.querySelector('[aria-label="Fallback 1 model"]')!.parentElement!.querySelector('select') as HTMLSelectElement;
  assert.deepEqual(
    [...fallbackSelect.options].map((o) => o.value),
    ['openai', 'anthropic', 'deepseek'],
    'no server of your own outside a config for one',
  );
  fallbackSelect.value = 'deepseek';
  fallbackSelect.dispatchEvent(new Event('change', { bubbles: true }));
  await type(form.querySelector('[aria-label="Fallback 1 model"]'), 'deepseek-chat');
  await click(byText(form.querySelector('[aria-label="Fallback 2 model"]')!.parentElement!, 'Remove'));
  calls.length = 0;
  await click(byText(form, 'Save'));
  assert.deepEqual(calls, [
    [
      'saveConfig',
      {
        name: 'Fast',
        provider: 'openai',
        model: 'gpt-y',
        tierModels: { haiku: 'gpt-mini' },
        fallbacks: [{ provider: 'deepseek', model: 'deepseek-chat' }],
      },
    ],
  ]);
  assert.equal(v.host.querySelector('.routing-editor'), null, 'saved: the form closes');
  // edit keeps the id; a refusal keeps the form
  await click(byText(v.host.querySelector('[data-row="Work"]')!, 'Edit'));
  const edit = v.host.querySelector('.routing-editor')!;
  assert.equal(input(edit, 'Haiku model (optional)')!.value, 'gpt-mini');
  refuse = 'Choose a provider.';
  calls.length = 0;
  await click(byText(edit, 'Save'));
  assert.equal(calls[0][0], 'saveConfig');
  assert.equal((calls[0][1] as { id?: string }).id, 'c1');
  assert.deepEqual(calls.at(-1), ['toast', 'Choose a provider.', 'error']);
  assert.ok(v.host.querySelector('.routing-editor'), 'refused: the form stays');
  refuse = null;
  await click(byText(edit, 'Cancel'));
  assert.equal(v.host.querySelector('.routing-editor'), null);
  await v.unmount();
});

test('a server of your own: its URL, and a key saved for that URL after the config', async () => {
  providers = catalog();
  configs = { configs: [{ ...work, provider: 'custom', baseUrl: 'http://localhost:11434/v1', fallbacks: [] }], invalid: 0, state: 'ok' };
  const v = await page();
  assert.equal(v.host.querySelector('[data-row="Work"] i')!.textContent, 'http://localhost:11434/v1 · gpt-x');
  await click(byText(v.host, 'Add model config'));
  const form = v.host.querySelector('.routing-editor')!;
  const pick = form.querySelector('select') as HTMLSelectElement;
  pick.value = 'custom';
  pick.dispatchEvent(new Event('change', { bubbles: true }));
  await flush();
  await type(input(form, 'Name'), 'Local');
  await type(input(form, 'Server URL'), 'http://localhost:8000/v1');
  await type(input(form, 'Model'), 'llama');
  await click(byText(form, 'Add a fallback', 'button'));
  assert.deepEqual(
    [...(form.querySelector('[aria-label="Fallback 1 model"]')!.parentElement!.querySelector('select') as HTMLSelectElement).options].map(
      (o) => o.value,
    ),
    ['openai', 'anthropic', 'deepseek', 'custom'],
  );
  await click(byText(form.querySelector('[aria-label="Fallback 1 model"]')!.parentElement!, 'Remove'));
  calls.length = 0;
  await click(byText(form, 'Save'));
  assert.deepEqual(calls, [
    [
      'saveConfig',
      { name: 'Local', provider: 'custom', baseUrl: 'http://localhost:8000/v1', model: 'llama', tierModels: {}, fallbacks: [] },
    ],
  ]);
  await click(byText(v.host, 'Add model config'));
  const again = v.host.querySelector('.routing-editor')!;
  const p2 = again.querySelector('select') as HTMLSelectElement;
  p2.value = 'custom';
  p2.dispatchEvent(new Event('change', { bubbles: true }));
  await flush();
  await type(input(again, 'Name'), 'Local');
  await type(input(again, 'Server URL'), 'http://localhost:8000/v1');
  await type(input(again, 'Server key (optional)'), ' tok-1 ');
  await type(input(again, 'Model'), 'llama');
  calls.length = 0;
  await click(byText(again, 'Save'));
  assert.deepEqual(
    calls.map((c) => c[0]),
    ['saveConfig', 'setKey'],
  );
  assert.deepEqual(calls[1], ['setKey', 'custom', 'tok-1', 'http://localhost:8000/v1']);
  await v.unmount();
});

test('files that can’t be read say so, and nothing that would change them is offered', async () => {
  providers = { ...catalog(), keys: 'unreadable' };
  configs = { configs: [work], invalid: 0, state: 'unreadable' };
  const v = await page();
  assert.ok(v.host.querySelector('[data-row="Saved keys can\'t be read"]'));
  assert.ok(v.host.querySelector('[data-row="Saved model configs can\'t be read"]'));
  assert.equal((byText(v.host.querySelector('[data-row="DeepSeek"]')!, 'Add key') as HTMLButtonElement).disabled, true);
  assert.equal((byText(v.host.querySelector('[data-row="Work"]')!, 'Edit') as HTMLButtonElement).disabled, true);
  assert.equal((byText(v.host, 'Add model config') as HTMLButtonElement).disabled, true);
  await v.unmount();
  // with no provider a request can go to, there is nothing to make a config for
  providers = { providers: [provider('gemini', 'Google Gemini', { wires: ['gemini'] })], keys: 'ok' };
  configs = { configs: [], invalid: 0, state: 'ok' };
  const none = await page();
  assert.equal((byText(none.host, 'Add model config') as HTMLButtonElement).disabled, true);
  await none.unmount();
});

test('the store reads again on a change in any window; a read that fails keeps what was shown, and a late one never replaces a newer', async () => {
  providers = catalog();
  configs = { configs: [], invalid: 0, state: 'ok' };
  const v = await page();
  assert.match(v.host.querySelector('[data-row="Model configs"] i')!.textContent!, /None saved yet/);
  configs = { configs: [work], invalid: 0, state: 'ok' };
  changed();
  await flush();
  await flush();
  assert.ok(v.host.querySelector('[data-row="Work"]'));
  assert.match(v.host.querySelector('[data-row="Model configs"] i')!.textContent!, /the one chosen under Pay with/);
  const realConfigs = configs;
  configs = Promise.reject(new Error('main went away')) as any;
  (configs as any).catch(() => {});
  await reloadRouting();
  configs = realConfigs;
  await flush();
  assert.ok(v.host.querySelector('[data-row="Work"]'), 'a failed read keeps the last answer');
  // an older read that answers after a newer one is dropped
  let release: (v: any) => void = () => {};
  const slow = new Promise((r) => (release = r));
  const fast = { configs: [], invalid: 0, state: 'ok' };
  configs = slow;
  const older = reloadRouting();
  configs = fast;
  await reloadRouting();
  release({ configs: [work], invalid: 0, state: 'ok' });
  await older;
  await flush();
  assert.equal(v.host.querySelector('[data-row="Work"]'), null);
  await v.unmount();
  assert.equal(claudeRoutable(provider('gemini', 'G', { wires: ['gemini'] }) as any), false);
});
