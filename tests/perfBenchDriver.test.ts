// The streaming benchmark's driver (scripts/perf-bench/driver.mjs) over a fake Playwright app: the scratch profile, the control
// folder, the clicks for each harness, and a chat that started on another harness than the one picked.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ACP_ID, LABELS, createDriver, prepare, readEvents, warmSettings, writeSettings } from '../scripts/perf-bench/driver.mjs';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'perf-bench-driver-'));

test('the scratch profile: its own homes, the three fakes as the installed harnesses, the probe on, background unless told', () => {
  const dir = tmp();
  const { env, userData, ctl } = prepare(dir, { base: { PATH: '/bin', LANG: 'C', SECRET: 'x' }, node: '/n/node' });
  assert.equal(env.HOME, path.join(dir, 'home'));
  assert.equal(env.MOPILOT_USER_DATA, userData);
  assert.equal(env.PERF_BENCH_CONTROL, ctl);
  assert.equal(env.MOPILOT_FLAGS, 'shared.perf.probe=1');
  assert.equal(env.SAGE_E2E_BACKGROUND, '1');
  assert.equal(env.PATH, '/bin');
  assert.equal(env.SECRET, undefined);
  assert.match(env.CODEX_BIN, /scripts\/perf-bench\/fake-app-server\.mjs$/);
  assert.match(env.CLAUDE_BIN, /scripts\/perf-bench\/fake-claude\.mjs$/);
  const bins = JSON.parse(env.SAGE_ACP_BINS);
  assert.deepEqual(Object.keys(bins), [ACP_ID]);
  assert.match(fs.readFileSync(bins[ACP_ID], 'utf8'), /exec "\/n\/node" ".*fake-acp\.mjs" "\$@"/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(userData, 'ui-state.json'), 'utf8')).codexBin, env.CODEX_BIN);
  assert.equal(prepare(tmp(), { foreground: true }).env.SAGE_E2E_BACKGROUND, undefined);
  assert.equal(typeof prepare(tmp()).env.HOME, 'string');
  assert.deepEqual(LABELS, { codex: 'Codex', claude: 'Claude Code', acp: 'Kimi Code' });
});

test('settings and events in the control folder', () => {
  const ctl = tmp();
  assert.deepEqual(readEvents(ctl), []);
  writeSettings(ctl, warmSettings(100));
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(ctl, 'replay.json'), 'utf8')), {
    mode: 'replay',
    bytes: 100,
    rate: 1_000_000,
    chunk: 100,
    gate: false,
  });
  fs.writeFileSync(path.join(ctl, 'events.jsonl'), '{"kind":"end","at":1}\n\n');
  assert.deepEqual(readEvents(ctl), [{ kind: 'end', at: 1 }]);
  fs.appendFileSync(path.join(ctl, 'events.jsonl'), '{"kind":');
  assert.deepEqual(readEvents(ctl), [{ kind: 'end', at: 1 }]);
  fs.appendFileSync(path.join(ctl, 'events.jsonl'), '"next","at":2}\n');
  assert.deepEqual(readEvents(ctl), [
    { kind: 'end', at: 1 },
    { kind: 'next', at: 2 },
  ]);
});

/** A Playwright Electron app whose page records what is done to it; each Send ends a turn as a fake would. */
function fakeElectron(o: { chatRecord?: boolean; ext?: string; kind?: string } = {}) {
  const actions: string[] = [];
  const state = {
    ctl: '',
    userData: '',
    stops: 0,
    chats: 0,
    windows: 1,
    polls: 0,
    kind: '',
    firstClass: true,
    launched: null as any,
    focused: 0,
    closed: 0,
  };
  const locator = (what: string): any => ({
    first: () => locator(`${what} (first)`),
    click: async () => {
      actions.push(`click ${what}`);
      if (what === 'button Send') {
        fs.appendFileSync(path.join(state.ctl, 'events.jsonl'), `${JSON.stringify({ kind: 'end', at: Date.now() })}\n`);
        if (state.chats > 0 && o.chatRecord !== false) {
          fs.mkdirSync(path.join(state.userData, 'threads'), { recursive: true });
          // an older .json record has no segments; a .v2 one starts on the harness picked (or the one a test forces)
          const record = o.ext === '.json' ? {} : { segments: [{ kind: o.kind ?? state.kind }] };
          fs.writeFileSync(path.join(state.userData, 'threads', `chat%3A${state.chats}${o.ext ?? '.v2'}`), JSON.stringify(record));
          state.chats = 0;
        }
      }
      if (what.startsWith('button /^New chat/')) state.chats = 1 + fs.readdirSync(path.join(state.userData)).length;
      const row = /^\.hp-harnesses \.hp-row (.*)$/.exec(what)?.[1];
      if (row) state.kind = { Codex: 'codex', 'Claude Code': 'claude', 'Kimi Code': 'acp:kimi' }[row] ?? row;
    },
    fill: async (text: string) => void actions.push(`fill ${text}`),
    waitFor: async () => undefined,
    count: async () =>
      what === 'button Select harness and model'
        ? Number(state.firstClass)
        : what === 'button.send-btn.stop' && state.stops > 0
          ? state.stops--
          : 0,
  });
  const page = {
    getByRole: (role: string, opts: any) => locator(`${role} ${opts.name}`),
    locator: (sel: string, opts?: any) => locator(opts?.hasText ? `${sel} ${opts.hasText}` : sel),
    evaluate: async (fn: (a: any) => unknown, arg: any) => {
      const prev = (globalThis as any).window;
      (globalThis as any).window = { native: { win: { open: (hash: string) => (actions.push(`open ${hash}`), state.windows++) } } };
      try {
        return fn(arg);
      } finally {
        (globalThis as any).window = prev;
      }
    },
  };
  const win = { focus: () => void state.focused++, webContents: { send: (...a: unknown[]) => void actions.push(`send ${a.join(' ')}`) } };
  const electron = {
    launch: async (opts: any) => {
      state.launched = opts;
      state.ctl = opts.env.PERF_BENCH_CONTROL;
      state.userData = opts.env.MOPILOT_USER_DATA;
      return {
        firstWindow: async () => page,
        // a window opened shows up a poll later
        windows: () => Array.from({ length: state.polls++ > 1 ? state.windows : 1 }),
        browserWindow: async (p: unknown) => (assert.equal(p, page), { evaluate: async (fn: any, arg: any) => fn(win, arg) }),
        close: async () => {
          state.closed++;
          fs.mkdirSync(path.join(state.userData, 'perf'), { recursive: true });
          fs.writeFileSync(path.join(state.userData, 'perf', 'run.jsonl'), '');
          fs.writeFileSync(path.join(state.userData, 'perf', 'notes.txt'), '');
        },
      };
    },
  };
  return { electron, actions, state };
}

test('the driver starts an instance, makes a chat on each harness, sends, switches, shows chats and windows, and stops', async () => {
  const f = fakeElectron();
  const logs: string[] = [];
  const d = createDriver({ electron: f.electron, root: '/repo', sleep: async () => undefined, log: (s) => logs.push(s) });
  const dir = tmp();
  const s = await d.start(dir, { foreground: true, base: {} });
  assert.deepEqual(f.state.launched.args, ['--use-mock-keychain', '/repo']);
  assert.equal(f.state.launched.cwd, '/repo');
  f.state.stops = 1;
  const id = await d.newChat(s, 'codex', '[bench] warm 1');
  assert.match(id, /^chat:\d+$/);
  assert.match(logs[0], /^chat chat:\d+ on codex$/);
  await d.newChat(s, 'acp', '[bench] warm 1');
  assert.deepEqual(f.actions.slice(0, 7), [
    'click button /^New chat/ (first)',
    'click button Select model',
    'click button Select harness and model',
    'click .hp-harnesses .hp-row Codex',
    'click .hp-models .menu-item (first)',
    'fill [bench] warm 1',
    'click button Send',
  ]);
  assert.ok(!f.actions.slice(7).some((a) => a.includes('hp-models')), 'the basic harness has no model list');
  // the new chat stays on the basic harness, whose model button opens the harness list at once
  f.actions.length = 0;
  f.state.firstClass = false;
  await d.pickHarness(s, 'codex');
  assert.deepEqual(f.actions, ['click button Select model', 'click .hp-harnesses .hp-row Codex']);
  f.state.firstClass = true;
  f.actions.length = 0;
  await d.switchHarness(s, 'claude');
  await d.openChat(s, id);
  await d.openWindow(s, id);
  await d.focus(s);
  assert.deepEqual(f.actions, [
    'click button Select model',
    'click button Select harness and model',
    'click .hp-harnesses .hp-row Claude Code',
    'click .hp-models .menu-item (first)',
    'click button Switch',
    `send app:command open-chat ${id}`,
    `open thread=${encodeURIComponent(id)}`,
  ]);
  assert.equal(f.state.focused, 1);
  await d.focus({ ...s, foreground: false });
  assert.equal(f.state.focused, 1, 'background mode never takes focus');
  const perf = path.join(s.userData, 'perf');
  fs.mkdirSync(perf, { recursive: true });
  fs.writeFileSync(path.join(perf, 'stalls.jsonl'), '{"kind":"stall"}\n');
  fs.writeFileSync(path.join(perf, 'stalls.1.jsonl'), '{"kind":"stall"}\n');
  assert.deepEqual(await d.stop(s, dir), [path.join('userData', 'perf', 'run.jsonl')]);
});

test('the driver reads older .json chat records, reports no probe files when there are none, and times out with what it waited for', async () => {
  const f = fakeElectron({ ext: '.json' });
  let t = 0;
  const d = createDriver({ electron: f.electron, root: '/repo', now: () => (t += 1000), sleep: async () => undefined });
  const dir = tmp();
  const s = await d.start(dir);
  assert.match(await d.newChat(s, 'claude', 'x'), /^chat:\d+$/);
  await assert.rejects(d.waitTurns(s, 5, 0, 3000), /timed out after 3 s waiting for 5 turns to end/);
  f.state.stops = 100;
  await assert.rejects(d.waitTurns(s, 1, 0, 3000), /waiting for the chat to be idle/);
  fs.rmSync(path.join(s.userData, 'threads'), { recursive: true });
  const g = fakeElectron({ chatRecord: false });
  const d2 = createDriver({ electron: g.electron, root: '/repo', now: () => (t += 10_000), sleep: async () => undefined });
  const s2 = await d2.start(tmp());
  await assert.rejects(d2.newChat(s2, 'codex', 'x'), /waiting for the new chat record/);
  const empty = { ...s, app: { close: async () => undefined }, userData: tmp() };
  assert.deepEqual(await d.stop(empty, dir), []);
  // the real clock and sleep
  const d3 = createDriver({ electron: fakeElectron().electron, root: '/repo', pollMs: 1 });
  const s3 = await d3.start(tmp());
  await assert.rejects(d3.waitTurns(s3, 1, Date.now() + 60_000, 5), /timed out/);
});

test('a chat that started on another harness than the one picked fails instead of being measured under the wrong label', async () => {
  const f = fakeElectron({ kind: 'claude' });
  const d = createDriver({ electron: f.electron, root: '/repo', sleep: async () => undefined });
  const s = await d.start(tmp());
  await assert.rejects(
    d.newChat(s, 'codex', 'x'),
    (e: any) => /^chat chat:\d+ started on claude, not codex$/.test(e.message) && e.wrongHarness === true,
  );
});
