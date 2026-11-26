// The phone's New chat starts on the agent, model and effort the last chat started on that computer used (mobile/src/remote/lastPicks.ts), while the computer still offers them; a pick made on the screen stands.
import { beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { flush } from './support/phone/component-kit';
import { scripted, fakeMedia, menus } from './support/phone/m3';
import { mount, button, chip, tap, typeIn, row } from './support/phone/newchat-kit';

const { forgetPicks, lastPick, rememberPick } = await import('../mobile/src/remote/lastPicks');
beforeEach(() => forgetPicks());

const SNAP = { phase: 'online', generation: 1, selectedPair: 'p', pairs: [{ pairId: 'p', macId: 'm', name: 'Studio Mac' }], presence: {} };
const MACHINES = {
  machines: [
    { id: 'local', name: 'Studio Mac', status: 'online', line: 'This Mac', tone: 'ok', agents: [] },
    {
      id: 'h1',
      name: 'mac-mini-test',
      status: 'online',
      line: 'Online · direct',
      tone: 'ok',
      agents: [
        { id: 'claude', label: 'Claude Code', state: 'ready', via: 'key' },
        { id: 'codex', label: 'Codex', state: 'ready', via: 'key' },
      ],
    },
  ],
};
// each agent offers its own model and a second one
const options = (harness: string) => {
  const base = menus.options(harness);
  return { ...base, models: [...base.models, { ...base.models[0], id: `${harness}-2`, label: `${harness} two` }] };
};
function computer() {
  const made = scripted((m, p) => {
    if (m === 'machine.hello') return { ...menus.hello, capabilities: { ...menus.hello.capabilities, machines: true } };
    if (m === 'machines.list') return MACHINES;
    if (m === 'options.get') return options(p.harness);
    if (m === 'chat.start') return { chatId: 'c1' };
    return undefined;
  });
  made.runtime.onEvent = () => () => undefined;
  return made;
}
const starts = (calls: any[]) => calls.filter((c) => c[0] === 'chat.start').map((c) => c[1]);
const pill = (host: HTMLElement) =>
  button(host, 'Model')?.getAttribute('aria-label') ?? host.querySelector('[aria-label^="Model,"]')?.getAttribute('aria-label');

test("this Mac's last agent, model and effort start the next chat, and a start is remembered", async () => {
  rememberPick('p', 'local', { harness: 'codex', model: 'codex-2', effort: 'high' });
  const { runtime, calls } = computer();
  const { host } = await mount(runtime, fakeMedia().media, {}, SNAP);
  await flush();
  assert.ok(chip(host, 'Agent').textContent!.includes('Codex'));
  assert.equal(pill(host), 'Model, codex two High');
  await typeIn('hello');
  await tap(button(host, 'Start chat')!);
  await flush();
  assert.deepEqual(
    starts(calls).map((s) => [s.harness, s.model, s.effort]),
    [['codex', 'codex-2', 'high']],
  );
  assert.deepEqual(lastPick('p', 'local'), { harness: 'codex', model: 'codex-2', effort: 'high' });
});

test('a remembered model the Mac no longer lists, or an effort it no longer offers, falls back to what the Mac chose', async () => {
  rememberPick('p', 'local', { harness: 'claude', model: 'gone', effort: 'high' });
  const first = await mount(computer().runtime, fakeMedia().media, {}, SNAP);
  await flush();
  assert.equal(pill(first.host), 'Model, claude model Low');
  rememberPick('p', 'local', { harness: 'claude', model: 'claude-2', effort: 'max' });
  const second = await mount(computer().runtime, fakeMedia().media, {}, SNAP);
  await flush();
  assert.equal(pill(second.host), 'Model, claude two Low');
});

test("picking a computer starts on its last agent, model and effort, also under the agent already picked; the screen's own pick stands until then", async () => {
  rememberPick('p', 'h1', { harness: 'codex', model: 'codex-2', effort: 'high' });
  const { runtime, calls } = computer();
  const { host } = await mount(runtime, fakeMedia().media, {}, SNAP);
  await flush();
  // the same agent on this Mac first: the computer's memory applies to the options already loaded
  await tap(chip(host, 'Agent'));
  await row('Codex');
  await flush();
  assert.equal(pill(host), 'Model, codex model Low');
  await tap(chip(host, 'Computer'));
  await row('mac-mini-test');
  await flush();
  assert.ok(chip(host, 'Agent').textContent!.includes('Codex'));
  assert.equal(pill(host), 'Model, codex two High');
  // a computer with nothing remembered keeps what is picked
  await tap(chip(host, 'Computer'));
  await row('Studio Mac');
  await flush();
  assert.ok(chip(host, 'Agent').textContent!.includes('Codex'));
  assert.equal(starts(calls).length, 0);
});

test('a Mac that lists no agent leaves none picked, remembered or not, and asks for no options', async () => {
  rememberPick('p', 'local', { harness: 'claude', model: 'claude-m', effort: 'low' });
  const { runtime, calls } = scripted((m) => (m === 'harnesses.list' ? { harnesses: [] } : undefined));
  const { host } = await mount(runtime, fakeMedia().media, {}, SNAP);
  await flush();
  assert.equal(calls.filter((c) => c[0] === 'options.get').length, 0);
  assert.equal(button(host, 'Start chat')?.disabled ?? true, true);
});
