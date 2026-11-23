// The host tools (electron/capabilities/tools/hostActionTools.cjs): a file opens in an editor, and a path shows in the file
// manager, only from the chat's own folders after the user approved that exact path; keep-awake is approved once per session,
// held for the chat and not left behind when the call or the session ends.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { Registry } = require('../electron/capabilities/contract/registry.cjs');
const { registerHostActionTools } = require('../electron/capabilities/tools/hostActionTools.cjs');
const { createSessionFolders } = require('../electron/capabilities/tools/sessionFolders.cjs');
const { KeepAwake } = require('../electron/platform/keepAwake.cjs');

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'host-tools-')));
const project = path.join(root, 'project');
fs.mkdirSync(path.join(project, 'src'), { recursive: true });
fs.writeFileSync(path.join(project, 'src', 'a.ts'), 'x');
fs.writeFileSync(path.join(project, 'w.code-workspace'), '{}');
fs.writeFileSync(path.join(project, 'notes:12'), 'x');
fs.writeFileSync(path.join(root, 'outside.ts'), 'x');

type Over = {
  installed?: string[];
  preferred?: string | null;
  answer?: any;
  open?: { ok: boolean; error?: string };
  revealThrows?: boolean;
  blocker?: boolean;
  onAsk?: (card: any) => void;
};

function setup(over: Over = {}) {
  const r = new Registry();
  r.setApprover(async () => true);
  const cards: any[] = [];
  const opened: any[] = [];
  const revealed: string[] = [];
  const blocks: string[] = [];
  const keepAwake = new KeepAwake({
    blocker: over.blocker === false ? null : { start: () => (blocks.push('start'), 1), stop: () => void blocks.push('stop') },
    setTimer: () => 0,
    clearTimer: () => undefined,
  });
  registerHostActionTools(r, {
    owner: (ctx: any) => (ctx.segmentId === 'seg' ? ctx.chatId : null),
    sessionFolders: createSessionFolders({ projectOf: async () => project, extraOf: () => [], home: root }),
    ask: async (chatId: string, _signal: any, card: any) => {
      cards.push([chatId, card]);
      over.onAsk?.(card);
      return over.answer === undefined ? { decision: 'allow', choice: 'allow' } : over.answer;
    },
    editors: {
      installed: () => over.installed ?? ['vscode'],
      open: async (...a: any[]) => (opened.push(a), over.open ?? { ok: true }),
      label: (id: string) => ({ vscode: 'VS Code', cursor: 'Cursor', zed: 'Zed' })[id as 'zed'] ?? id,
    },
    preferredEditor: () => (over.preferred === undefined ? null : over.preferred),
    reveal: (p: string) => {
      if (over.revealThrows) throw new Error('no finder');
      revealed.push(p);
    },
    fileManager: 'Finder',
    keepAwake,
    idleMinutes: 10,
  });
  const call = async (tool: string, args: any, ctxOver: any = {}) => {
    const res = await r.invoke('c', 'seg', tool, args, ctxOver);
    return res.ok ? res.content[0].text : `ERROR ${res.error.code}: ${res.error.message}`;
  };
  return { r, call, cards, opened, revealed, blocks, keepAwake };
}
const a = path.join(project, 'src', 'a.ts');

test('the three tools are registered under their Claude Desktop names, each answering for the chat that owns the call', async () => {
  const t = setup();
  assert.deepEqual(
    t.r.list().map((x: any) => [x.name, x.policy]),
    [
      ['open_in_editor', 'act'],
      ['reveal_path', 'act'],
      ['request_keep_awake', 'act'],
    ],
  );
  assert.match(String((await t.r.invoke('c', 'other', 'reveal_path', { path: a })).error?.message), /does not own/);
});

test('open_in_editor: the user approves the resolved path, the editor is asked once, at the line and column', async () => {
  const t = setup();
  assert.equal(
    await t.call('open_in_editor', { path: 'src/a.ts', line: 12, column: 3 }),
    `Asked VS Code to open ${a} at line 12, column 3.`,
  );
  assert.deepEqual(t.cards[0][1], {
    title: 'Open',
    message: 'Open this file in your code editor?',
    details: [a, 'Line 12, column 3'],
    choices: [{ id: 'allow', label: 'Allow' }],
  });
  assert.deepEqual(t.opened, [['vscode', a, 12, 3]]);
  assert.equal(await t.call('open_in_editor', { path: a, line: 5, column: 99 }), `Asked VS Code to open ${a} at line 5, column 99.`);
  assert.equal(await t.call('open_in_editor', { path: a, line: 5 }), `Asked VS Code to open ${a} at line 5.`);
  assert.equal(await t.call('open_in_editor', { path: a, column: 4 }), `Asked VS Code to open ${a}.`);
  assert.deepEqual(t.cards[3][1].details, [a], 'a column without a line is ignored');
});

test('open_in_editor: the editor is the one asked for, the one chosen in Settings, the only one installed, or the user is asked', async () => {
  const two = { installed: ['vscode', 'cursor'] };
  assert.match(
    await setup(two).call('open_in_editor', { path: a }),
    /^ERROR choose_editor: Several editors are installed \(vscode \(VS Code\), cursor \(Cursor\)\)/,
  );
  const asked = setup(two);
  assert.match(await asked.call('open_in_editor', { path: a, editor: 'cursor' }), /^Asked Cursor to open/);
  assert.equal(asked.opened[0][0], 'cursor');
  const preferred = setup({ ...two, preferred: 'cursor' });
  await preferred.call('open_in_editor', { path: a });
  assert.equal(preferred.opened[0][0], 'cursor');
  // a preference for an editor that is not installed any more falls back to the only one there is
  const stale = setup({ installed: ['zed'], preferred: 'cursor' });
  await stale.call('open_in_editor', { path: a });
  assert.equal(stale.opened[0][0], 'zed');
  assert.match(
    await setup().call('open_in_editor', { path: a, editor: 'zed' }),
    /^ERROR not_installed: Zed is not installed\. Installed: vscode \(VS Code\)\./,
  );
  assert.match(await setup({ installed: [] }).call('open_in_editor', { path: a }), /^ERROR no_editor: No supported code editor/);
  assert.match(
    await setup().call('open_in_editor', { path: a, editor: 'emacs' }),
    /^ERROR invalid_args: `editor` must be one of vscode, cursor, windsurf, zed/,
  );
});

test('open_in_editor refuses before asking: folders, workspace files, names that read as a line, bad numbers, paths outside the folders', async () => {
  const t = setup();
  assert.match(await t.call('open_in_editor', { path: 'src' }), /^ERROR not_a_file: open_in_editor opens files, not folders/);
  assert.match(await t.call('open_in_editor', { path: 'w.code-workspace' }), /^ERROR not_a_file: .*workspace files/);
  assert.match(await t.call('open_in_editor', { path: 'notes:12' }), /^ERROR refused_path: .*colon and digits/);
  for (const bad of [{ line: 0 }, { line: 1.5 }, { line: 1e8 }, { line: 2, column: 0 }])
    assert.match(
      await t.call('open_in_editor', { path: a, ...bad }),
      /^ERROR invalid_args: `(line|column)` must be a whole number from 1 to 10000000/,
      JSON.stringify(bad),
    );
  assert.match(
    await t.call('open_in_editor', { path: path.join(root, 'outside.ts') }),
    /^ERROR not_found: That path is not a file or folder inside this session's folders/,
  );
  assert.deepEqual(t.cards, [], 'nothing was shown to the user, and nothing opened');
  assert.deepEqual(t.opened, []);
});

test('open_in_editor: a decline opens nothing; a path that changed while the card waited opens nothing; a failed launch says why', async () => {
  const declined = setup({ answer: { decision: 'deny' } });
  assert.match(await declined.call('open_in_editor', { path: a }), /^ERROR denied: The user declined, so nothing was opened/);
  assert.deepEqual(declined.opened, []);
  const link = path.join(project, 'moving.ts');
  fs.writeFileSync(path.join(project, 'one.ts'), '1');
  fs.writeFileSync(path.join(project, 'two.ts'), '2');
  fs.symlinkSync(path.join(project, 'one.ts'), link);
  const moved = setup({
    onAsk: () => {
      fs.rmSync(link);
      fs.symlinkSync(path.join(project, 'two.ts'), link);
    },
  });
  assert.match(await moved.call('open_in_editor', { path: link }), /^ERROR changed: That path no longer resolves to what was approved/);
  assert.deepEqual(moved.opened, []);
  // the file is gone altogether by then
  const gone = setup({ onAsk: () => fs.rmSync(path.join(project, 'two.ts')) });
  assert.match(await gone.call('open_in_editor', { path: path.join(project, 'two.ts') }), /^ERROR changed/);
  const failed = setup({ open: { ok: false, error: 'spawn ENOENT' } });
  assert.match(
    await failed.call('open_in_editor', { path: a }),
    /^ERROR launch_failed: Could not open .* in VS Code\. Tell the user the path instead\./,
  );
});

test('reveal_path shows a file or a folder in the file manager after the card, and says which it was', async () => {
  const t = setup();
  assert.equal(await t.call('reveal_path', { path: 'src/a.ts' }), `Revealed ${a} in Finder.`);
  assert.equal(await t.call('reveal_path', { path: 'src' }), `Revealed folder ${path.join(project, 'src')} in Finder.`);
  assert.deepEqual(t.revealed, [a, path.join(project, 'src')]);
  assert.equal(t.cards[0][1].message, 'Show this in Finder?');
  assert.match(await setup({ answer: null }).call('reveal_path', { path: a }), /^ERROR denied/);
  assert.match(await setup().call('reveal_path', { path: path.join(root, 'outside.ts') }), /^ERROR not_found/);
  const broken = setup({ revealThrows: true });
  assert.match(await broken.call('reveal_path', { path: a }), /^ERROR launch_failed: Could not reveal/);
});

test('request_keep_awake: asked once per session, then held for the turn or the idle session, and changed by a second call', async () => {
  const t = setup();
  const first = await t.call('request_keep_awake', { until: 'turn_end', reason: 'Waiting for CI.' });
  assert.match(
    first,
    /^Keeping this computer awake until this turn finishes\. It ends early if the session is stopped or archived or the app quits/,
  );
  assert.deepEqual(t.cards[0][1], {
    title: 'Keep awake',
    message: 'Keep this computer awake while this session works?',
    details: ['Waiting for CI.'],
    choices: [{ id: 'allow', label: 'Allow' }],
  });
  assert.equal(t.keepAwake.isHeld('c'), true);
  const second = await t.call('request_keep_awake', { until: 'session_idle', reason: ' a   long\nbuild ' });
  assert.match(second, /^Updated the keep-awake hold until the session has been idle for about 10 minutes\./);
  assert.equal(t.cards.length, 1, 'approved once per session');
  assert.deepEqual(t.blocks, ['start']);
});

test('request_keep_awake: a decline holds nothing and keeps asking; bad input and a missing OS blocker are told apart', async () => {
  const declined = setup({ answer: { decision: 'deny' } });
  assert.match(
    await declined.call('request_keep_awake', { until: 'turn_end', reason: 'x' }),
    /^ERROR denied: The user did not allow keeping the computer awake/,
  );
  assert.match(await declined.call('request_keep_awake', { until: 'turn_end', reason: 'x' }), /^ERROR denied/);
  assert.equal(declined.cards.length, 2);
  assert.equal(declined.keepAwake.isHeld('c'), false);
  const t = setup();
  assert.match(await t.call('request_keep_awake', { until: 'forever', reason: 'x' }), /^ERROR invalid_args: `until` must be/);
  assert.match(await t.call('request_keep_awake', { until: 'turn_end', reason: '  ' }), /^ERROR invalid_args: `reason` is required/);
  assert.match(
    await t.call('request_keep_awake', { until: 'turn_end', reason: 'x'.repeat(201) }),
    /^ERROR invalid_args: `reason` is required/,
  );
  assert.match(await t.call('request_keep_awake', { until: 'turn_end', reason: 7 }), /^ERROR bad_args/);
  assert.deepEqual(t.cards, [], 'nothing asked for a bad call');
  assert.match(
    await setup({ blocker: false }).call('request_keep_awake', { until: 'turn_end', reason: 'x' }),
    /^ERROR unavailable: Keeping the computer awake isn't available/,
  );
});

test('request_keep_awake: a call stopped while its card was open holds nothing, and a hold ends with the turn the call was made in', async () => {
  const t = setup();
  const stop = new AbortController();
  const stopped = await t.call('request_keep_awake', { until: 'turn_end', reason: 'x' }, { signal: stop.signal, callId: 'k1' });
  assert.match(stopped, /Keeping this computer awake/);
  t.keepAwake.release('c');
  const racing = setup({ onAsk: () => stop2.abort() });
  const stop2 = new AbortController();
  // the registry answers a stopped call itself; the handler that is still running must not leave a hold behind
  assert.match(await racing.call('request_keep_awake', { until: 'turn_end', reason: 'x' }, { signal: stop2.signal }), /^ERROR aborted/);
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(racing.keepAwake.isHeld('c'), false);
  assert.deepEqual(racing.blocks, [], 'the OS blocker never started');
  // the turn the hold was made in ends: the computer may sleep again
  t.keepAwake.hold('c', 'turn_end');
  t.keepAwake.turnFinished('c');
  assert.equal(t.keepAwake.isHeld('c'), false);
  assert.deepEqual(t.blocks.slice(-1), ['stop']);
});
