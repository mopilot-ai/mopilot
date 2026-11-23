// The user's own MCP servers in a basic chat (#1575): when they crowd the model's context (src/lib/ownMcp.ts), the note a
// chat shows with each server one click from off, and Settings' rows (src/components/harness/OwnMcp.tsx).
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { window } from './support/dom.ts';
import { withStoreSlices } from './support/stubs.ts';
const document = window.document as unknown as Document;
import { act, createElement } from 'react';
import { crowding, toolCap, withLoad, withServer, kTokens, CROWDED_SHARE } from '../src/lib/ownMcp.ts';
import { installNativeStub } from './support/ports/native.ts';

const C = (n: number) => ({ id: `c${n}`, type: 'contextCompaction' });
const step = (n: number) => ({ id: `s${n}`, type: 'mcpToolCall' });
const loop = [{ type: 'userMessage' }, step(1), C(1), step(2), C(2), step(3), C(3)];

test('crowded: a compaction loop, or most of the window still in use after compacting or after a turn that only replied', () => {
  assert.equal(CROWDED_SHARE, 0.5);
  assert.deepEqual(crowding({ status: 'inProgress', items: loop }, null), { kind: 'loop', count: 3 });
  const usage = { used: 162_000, size: 200_000 };
  assert.deepEqual(crowding({ status: 'completed', items: [{ type: 'userMessage' }, step(1), C(1), { type: 'agentMessage' }] }, usage), {
    kind: 'full',
    used: 162_000,
    size: 200_000,
    after: 'compacting',
  });
  const replied = [{ type: 'userMessage' }, { type: 'reasoning' }, { type: 'agentMessage' }];
  assert.deepEqual(crowding({ status: 'completed', items: replied }, usage), {
    kind: 'full',
    used: 162_000,
    size: 200_000,
    after: 'reply',
  });
  // a turn that did work of its own holds that work in the context too: it says nothing about what is fixed
  assert.equal(crowding({ status: 'completed', items: [...replied, step(1)] }, usage), null);
  // under half, still running, failed, no usage or no window known, no turn
  assert.equal(crowding({ status: 'completed', items: replied }, { used: 99_999, size: 200_000 }), null);
  assert.equal(crowding({ status: 'inProgress', items: replied }, usage), null);
  assert.equal(crowding({ status: 'failed', items: replied }, usage), null);
  assert.equal(crowding({ status: 'completed', items: replied }, null), null);
  assert.equal(crowding({ status: 'completed', items: replied }, { used: 5, size: null }), null);
  assert.equal(crowding({ status: 'completed', items: replied }, { used: null, size: 5 }), null);
  assert.equal(crowding(null, usage), null);
  assert.equal(kTokens(158_336), '158k');
});

test('a turn refused for carrying more tools than the model takes: the cap is named, whatever the provider calls it (#1679)', () => {
  const opencode = {
    message: "Internal error: Upstream request failed: [invalid_value] Invalid value for 'tools': maximum number of items is 128.",
  };
  assert.equal(toolCap(opencode), 128);
  assert.equal(
    toolCap({ message: 'x', additionalDetails: "Invalid 'tools': array too long. Expected an array with maximum length 64, but got 90" }),
    64,
  );
  assert.equal(toolCap({ message: 'tools: list should have at most 100 items' }), 100);
  // other limits, other errors, no error and a cap that reads zero say nothing about tools
  assert.equal(toolCap({ message: 'maximum number of items is 10 in messages' }), null);
  // a limit on something else in the same text, or a mention of tools beside another limit, is not the tool cap
  assert.equal(toolCap({ message: 'prompt is too long: maximum length 200000 tokens, including tools' }), null);
  assert.equal(toolCap({ message: 'messages: maximum number of items is 500; tools: maximum number of items is 128' }), 128);
  assert.equal(toolCap({ message: 'tools: maximum number of items is 1,000' }), 1000);
  assert.equal(toolCap({ message: 'tools: maximum length 0' }), null);
  assert.equal(toolCap({ message: 'Rate limit exceeded' }), null);
  assert.equal(toolCap(null), null);
  const items = [{ type: 'userMessage' }];
  assert.deepEqual(crowding({ status: 'failed', items, error: opencode }, null), { kind: 'tools', max: 128 });
  // the refusal comes first, even when the turn also compacted in a loop
  const compacting = [{ type: 'userMessage' }, step(1), C(1), step(2), C(2), step(3), C(3)];
  assert.deepEqual(crowding({ status: 'failed', items: compacting, error: opencode }, null), { kind: 'tools', max: 128 });
  // only a failed turn: a turn still retrying, or one that completed, does not show the note
  assert.equal(crowding({ status: 'inProgress', items, error: opencode }, null), null);
  assert.equal(crowding({ status: 'failed', items, error: null }, null), null);
});

test('the choice: loading and each server, per harness, other harnesses kept', () => {
  const all = { kimi: { load: false } };
  assert.deepEqual(withLoad(all, 'opencode', false), { kimi: { load: false }, opencode: { load: false } });
  assert.deepEqual(withLoad(undefined, 'opencode', true), { opencode: { load: true } });
  const off = withServer(all, 'opencode', 'rea', true);
  assert.deepEqual(off, { kimi: { load: false }, opencode: { off: ['rea'] } });
  assert.deepEqual(withServer(off, 'opencode', 'rea', true).opencode.off, ['rea'], 'once');
  assert.deepEqual(withServer(off, 'opencode', 'rea', false).opencode.off, []);
  assert.deepEqual(withServer(undefined, 'opencode', 'docs', false), { opencode: { off: [] } });
});

// -- the components ----------------------------------------------------------------------------------------------
const f: any = { prefs: { acpMcp: {} }, runtime: {}, usage: null, status: {}, asked: [] };
const status = (o: any = {}) => ({
  harness: 'opencode',
  label: 'opencode',
  supported: true,
  load: true,
  servers: [
    { name: 'rea', enabled: true, off: false },
    { name: 'old', enabled: false, off: false },
  ],
  pending: false,
  ...o,
});
// the bridge the modules read, installed in the native port (src/lib/native.ts)
installNativeStub({
  acp: {
    ownMcp: async (h: string) => {
      f.asked.push(h);
      if (f.fail) throw new Error('gone');
      return f.status[h] ?? status({ harness: h, label: h });
    },
  },
});
for (const [rel, exports] of Object.entries(
  withStoreSlices(
    Object.fromEntries([
      [
        'store',
        {
          useStore: (sel: any) => sel(f),
          getState: () => f,
          setPrefs: (p: any) => void (f.prefs = { ...f.prefs, ...p }),
        },
      ],
      ['store/chats.ts', { nativeOf: (id: string) => id }],
      [
        'store/session/useSession.ts',
        {
          flushSessionPatches: () => {},
          useSession: () => ({ acp: f.usage ? { usage: f.usage } : null }),
          useSessionField: (id: any, pick: any) => pick(((() => ({ acp: f.usage ? { usage: f.usage } : null })) as (id: any) => any)(id)),
        },
      ],
    ] as const) as Record<string, Record<string, unknown>>,
  ),
))
  mock.module(new URL(`../src/${rel}`, import.meta.url).href, { namedExports: exports });
const { OwnMcpNotice, OwnMcpSettings } = await import('../src/components/harness/OwnMcp.tsx');
const { createRoot } = await import('react-dom/client');

async function show(el: any) {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => root.render(el));
  await act(async () => new Promise((r) => setTimeout(r, 0)));
  return {
    host,
    text: () => host.textContent ?? '',
    buttons: () => [...host.querySelectorAll('button')].map((b) => b.textContent),
    click: async (label: string) => {
      const b = [...host.querySelectorAll('button')].find((x) => x.textContent === label)!;
      await act(async () => b.click());
      await act(async () => new Promise((r) => setTimeout(r, 0)));
    },
    rerender: async (next: any) => {
      await act(async () => root.render(next));
      await act(async () => new Promise((r) => setTimeout(r, 0)));
    },
    unmount: async () => {
      await act(async () => root.unmount());
      host.remove();
    },
  };
}
const CHAT = 'acp:opencode:x';
const turnOf = (items: any[], s = 'inProgress') => ({ [CHAT]: { turns: [{ id: 't', status: s, items }] } });

test('the note: a loop names the cause and offers each listed server, off for MoPilot only; undo puts it back', async () => {
  f.prefs = { acpMcp: {} };
  f.runtime = turnOf(loop);
  f.status = { opencode: status() };
  const v = await show(createElement(OwnMcpNotice, { threadId: CHAT }));
  assert.match(
    v.text(),
    /Tools from MCP servers in opencode's global settings may be filling the model's context\. It compacted its context 3 times/,
  );
  assert.match(v.text(), /your opencode settings stay as they are\. It applies from the next message\./);
  assert.deepEqual(v.buttons(), ['Turn off rea'], 'a server off in its own settings is not offered');
  await v.click('Turn off rea');
  assert.deepEqual(f.prefs.acpMcp, { opencode: { off: ['rea'] } });
  // main reads the new choice, a turn still running: it applies once that turn ends
  f.status = { opencode: status({ servers: [{ name: 'rea', enabled: true, off: true }], pending: true }) };
  await v.rerender(createElement(OwnMcpNotice, { threadId: CHAT, key: 'again' }));
  assert.match(v.text(), /It applies when opencode's current turns end\./);
  await v.click('Turn rea back on');
  assert.deepEqual(f.prefs.acpMcp, { opencode: { off: [] } });
  await v.unmount();
});

test('the note: most of the window in use after compacting; all servers off, one button loads them again', async () => {
  f.prefs = { acpMcp: { opencode: { load: false } } };
  f.runtime = turnOf([{ type: 'userMessage' }, step(1), C(1), { type: 'agentMessage' }], 'completed');
  f.usage = { used: 162_000, size: 200_000 };
  f.status = { opencode: status({ load: false, servers: [{ name: 'rea', enabled: true, off: true }] }) };
  const v = await show(createElement(OwnMcpNotice, { threadId: CHAT }));
  assert.match(v.text(), /162k of the model's 200k-token window was still in use after compacting\./);
  assert.deepEqual(v.buttons(), ['Load them again']);
  await v.click('Load them again');
  assert.deepEqual(f.prefs.acpMcp, { opencode: { load: true } });
  await v.unmount();
  // after a turn that only replied
  f.runtime = turnOf([{ type: 'userMessage' }, { type: 'agentMessage' }], 'completed');
  const r = await show(createElement(OwnMcpNotice, { threadId: CHAT }));
  assert.match(r.text(), /after a turn that only replied\./);
  await r.unmount();
  f.usage = null;
});

test("the note: a harness that can't turn them off says where to; one with none listed says so; nothing when not crowded", async () => {
  f.runtime = turnOf(loop);
  f.status = { opencode: status({ supported: false, servers: [] }) };
  const v = await show(createElement(OwnMcpNotice, { threadId: CHAT }));
  assert.match(v.text(), /MoPilot can't turn them off for opencode: turn them off in opencode's own settings/);
  assert.deepEqual(v.buttons(), []);
  await v.unmount();
  f.status = { opencode: status({ servers: [{ name: 'old', enabled: false, off: false }] }) };
  const n = await show(createElement(OwnMcpNotice, { threadId: CHAT }));
  assert.match(n.text(), /opencode's global settings list no MCP servers to turn off/);
  await n.unmount();
  // not crowded, not a basic chat, or main can't be read: no note
  f.asked = [];
  f.runtime = turnOf([{ type: 'userMessage' }]);
  const q = await show(createElement(OwnMcpNotice, { threadId: CHAT }));
  assert.equal(q.text(), '');
  assert.deepEqual(f.asked, [], 'nothing asked of main while not crowded');
  await q.unmount();
  f.runtime = { claude: { turns: [{ id: 't', status: 'inProgress', items: loop }] } };
  const c = await show(createElement(OwnMcpNotice, { threadId: 'claude' }));
  assert.equal(c.text(), '');
  await c.unmount();
  f.runtime = { [CHAT]: { turns: [] } };
  const e = await show(createElement(OwnMcpNotice, { threadId: CHAT }));
  assert.equal(e.text(), '');
  await e.unmount();
  f.runtime = turnOf(loop);
  f.fail = true;
  const x = await show(createElement(OwnMcpNotice, { threadId: CHAT }));
  assert.equal(x.text(), '');
  await x.unmount();
  f.fail = false;
});

test('Settings: load them or not, and each server; one off in its own settings, or all off, cannot be turned on here', async () => {
  f.prefs = { acpMcp: {} };
  f.status = { opencode: status() };
  const v = await show(createElement(OwnMcpSettings, { harness: 'opencode' }));
  assert.match(v.text(), /Load MCP servers from opencode's global settings/);
  assert.match(
    v.text(),
    /In MoPilot's opencode chats only; your opencode settings stay as they are\. Servers a project's own settings add still load\./,
  );
  assert.match(v.text(), /Off in opencode's own settings/);
  const toggles = () => [...v.host.querySelectorAll('[role="switch"], button')] as HTMLElement[];
  assert.equal(toggles().length, 3);
  // the second switch is rea's
  await act(async () => toggles()[1].click());
  assert.deepEqual(f.prefs.acpMcp, { opencode: { off: ['rea'] } });
  await act(async () => toggles()[0].click());
  assert.deepEqual(f.prefs.acpMcp, { opencode: { off: ['rea'], load: false } });
  await v.unmount();
  // waiting for a turn to end, it says so
  f.status = { opencode: status({ pending: true }) };
  const p = await show(createElement(OwnMcpSettings, { harness: 'opencode' }));
  assert.match(p.text(), /It applies when opencode's current turns end\./);
  await p.unmount();
  f.status = { kimi: status({ harness: 'kimi', label: 'Kimi', supported: false, servers: [] }) };
  const k = await show(createElement(OwnMcpSettings, { harness: 'kimi' }));
  assert.match(k.text(), /MoPilot can't turn them off for Kimi; turn them off there\./);
  await k.unmount();
  // before main answers: nothing
  f.fail = true;
  const x = await show(createElement(OwnMcpSettings, { harness: 'opencode' }));
  assert.equal(x.text(), '');
  await x.unmount();
  f.fail = false;
});

test('Settings: a server MoPilot’s gateway runs shows so, off and fixed here; a harness MoPilot can’t switch says its copy loads directly', async () => {
  f.prefs = { acpMcp: {} };
  f.status = {
    opencode: status({
      servers: [
        { name: 'github', enabled: true, off: false, managed: true },
        { name: 'rea', enabled: true, off: false, managed: false },
      ],
    }),
  };
  const v = await show(createElement(OwnMcpSettings, { harness: 'opencode' }));
  assert.match(
    v.text(),
    /MoPilot's MCP gateway runs this server for every chat, under your rules, so this copy is off in MoPilot's chats\./,
  );
  const switches = [...v.host.querySelectorAll('[role="switch"], button')] as HTMLButtonElement[];
  // load, github (managed: off and fixed), rea
  assert.equal(switches.length, 3);
  assert.equal(switches[1].getAttribute('aria-checked'), 'false');
  assert.equal(switches[1].disabled, true);
  await v.unmount();
  f.status = { kimi: status({ harness: 'kimi', label: 'Kimi', supported: false, servers: [] }) };
  const k = await show(createElement(OwnMcpSettings, { harness: 'kimi' }));
  assert.match(k.text(), /is also loaded directly by Kimi, and your rules don't apply there\./);
  await k.unmount();
});

test('the note: a refused tool list names the cap and offers each server; without the capability it says where to turn them off', async () => {
  f.prefs = { acpMcp: {} };
  const refused = {
    [CHAT]: {
      turns: [
        {
          id: 't',
          status: 'failed',
          items: [{ type: 'userMessage' }],
          error: { message: "Invalid value for 'tools': maximum number of items is 128." },
        },
      ],
    },
  };
  f.runtime = refused;
  f.status = { opencode: status() };
  const v = await show(createElement(OwnMcpNotice, { threadId: CHAT }));
  assert.match(v.text(), /with MoPilot's own, are more than the model accepts\. This model takes at most 128 tools in a request/);
  assert.deepEqual(v.buttons(), ['Turn off rea']);
  await v.click('Turn off rea');
  assert.deepEqual(f.prefs.acpMcp, { opencode: { off: ['rea'] } });
  // the failed turn is still the latest: with a server off, say what another refusal would mean; the buttons undo it
  f.status = { opencode: status({ servers: [{ name: 'rea', enabled: true, off: true }], pending: true }) };
  await v.rerender(createElement(OwnMcpNotice, { threadId: CHAT, key: 'again' }));
  assert.match(v.text(), /If it is refused again, MoPilot's own tools alone are more than the model accepts\./);
  assert.deepEqual(v.buttons(), ['Turn rea back on']);
  await v.unmount();
  // every server off: the same, with the way back
  f.status = { opencode: status({ load: false, servers: [{ name: 'rea', enabled: true, off: true }] }) };
  const o = await show(createElement(OwnMcpNotice, { threadId: CHAT }));
  assert.match(o.text(), /MoPilot's own tools alone are more than the model accepts\./);
  assert.deepEqual(o.buttons(), ['Load them again']);
  await o.unmount();
  f.status = { opencode: status({ supported: false, servers: [] }) };
  const n = await show(createElement(OwnMcpNotice, { threadId: CHAT }));
  assert.match(n.text(), /turn them off in opencode's own settings, or pick a model that takes more tools\./);
  await n.unmount();
  f.status = { opencode: status({ servers: [{ name: 'old', enabled: false, off: false }] }) };
  const e = await show(createElement(OwnMcpNotice, { threadId: CHAT }));
  assert.match(e.text(), /^Tools from MCP servers in opencode's global settings, with MoPilot's own, are more than the model accepts\./);
  assert.match(e.text(), /list no MCP servers to turn off; a model that takes more tools would work\./);
  await e.unmount();
});
