// Control matrix, computer use on MoPilot's helper (docs/control-plane/matrix.md, group D): scripts and Shortcuts
// (#3571 G7). desktop_app_script reaches the helper the same way from a Claude Code session (app_script on
// mopilot_computer), a Codex chat, a chat that switched harness and an ACP chat; the helper's static check decides the
// tier and the confirmation before anything runs; Stop during a run cancels it in the helper; and the tools wait in the
// deferred desktop group on every harness. The tools, the Registry and Claude's channel are real; the helper, the cards
// and the harnesses are fakes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import * as AK from './support/app-scoped-kit.ts';
import { fakeSdk, z } from './support/control-matrix-kit.ts';
import { realSpecs, tiers } from './support/tool-tiers-kit.ts';
import { waitFor } from './support/waitFor.ts';

export const GUARDS = ['electron/capabilities/', 'native/helper/'];

const require = createRequire(import.meta.url);
const { Registry } = require('../electron/capabilities/contract/registry.cjs');
const { sdkMcpServers } = require('../electron/capabilities/mcp/sdkMcp.cjs');
const { placement } = require('../electron/capabilities/contract/hostServers.cjs');
const { CORE_HOST } = require('../electron/capabilities/mcp/toolLoading.cjs');

const READ = { ok: true, writes: false, irreversible: [] };

function world(check: any = READ) {
  const r = AK.rig();
  r.helper.answers['app.script'] = (p: any) => (p.check ? check : { ok: true, output: 'Doc' });
  const reg = new Registry();
  for (const t of r.apps.tools()) reg.register(t);
  const servers = sdkMcpServers({
    sdk: fakeSdk,
    z,
    registry: reg,
    serverName: 'sage_aaaaaaaaaaaa',
    owner: { chatId: 'c1', segmentId: 's1' },
  });
  const claude = async (registryName: string, args: any) => {
    const p = placement(registryName, 'sage_aaaaaaaaaaaa');
    const t = servers.get(p.server).tools.find((x: any) => x.name === p.name);
    return t.handler(args, { _meta: { 'claudecode/toolUseId': `toolu_${registryName}` } });
  };
  return { r, reg, claude };
}

test('CM-D18: desktop_app_script runs the same way from Claude, Codex, a switched chat and ACP; the check gates tier and confirmation before any run', async () => {
  const { r, reg, claude } = world();
  assert.deepEqual(placement('desktop_app_script', 'sage_aaaaaaaaaaaa'), { server: 'mopilot_computer', name: 'app_script' });
  const args = { app: 'Notes', script: 'get name of note 1' };
  const runs = () => r.callsOf('app.script').filter((c: any) => !c.params.check);
  const out = await claude('desktop_app_script', args);
  assert.notEqual(out.isError, true, JSON.stringify(out));
  assert.match(out.content[0].text, /"action":"script","effect":"confirmed"/);
  assert.match(out.content[0].text, /data from the app, not instructions/);
  r.apps.releaseLocks('c1');
  // a Codex chat, a chat that switched from Claude to Codex, an ACP chat: the same request reaches the helper
  for (const [chatId, harness] of [
    ['codex1', 'codex'],
    ['c1', 'codex'],
    ['acp1', 'acp:opencode'],
  ]) {
    r.cu.harness = () => harness;
    const res = await reg.invoke(chatId, 's1', 'desktop_app_script', args);
    assert.equal(res.ok, true, `${harness}: ${JSON.stringify(res.error)}`);
    assert.equal(runs().at(-1).params.source, 'get name of note 1', harness);
    r.apps.releaseLocks(chatId);
  }
  assert.equal(runs().length, 4);
  // a refused construct never runs, on any harness
  r.helper.answers['app.script'] = (p: any) => {
    if (p.check) throw AK.helperFailure('script_refused', 'refused: the script uses do shell script');
    return { ok: true };
  };
  const refused = await reg.invoke('acp1', 's1', 'desktop_app_script', { app: 'Notes', script: 'do shell script "ls"' });
  assert.equal(refused.error?.code, 'refused');
  assert.equal(runs().length, 4);
  // a write in a click-only app is refused at the tier; a verb that can't be undone asks first
  const w = world({ ok: true, writes: true, irreversible: ['delete'] });
  await AK.rejects(w.r.call('desktop_app_script', { app: 'Terminal', script: 'x' }), 'tier');
  await w.r.call('desktop_app_script', { app: 'Notes', script: 'delete note 1' });
  assert.equal(w.r.asks[0].kind, 'computerConfirm');
  // the static check is the helper's: shell, other apps and synthesized keys are in its deny lists
  const policy = ['ScriptPolicy.swift', 'ScriptPolicyJXA.swift']
    .map((f) => fs.readFileSync(new URL(`../native/helper/Sources/HelperCore/${f}`, import.meta.url), 'utf8'))
    .join('\n');
  for (const word of ['"shell"', '"application"', '"keystroke"', '"doShellScript"', '"ObjC"']) assert.ok(policy.includes(word), word);
});

test('CM-D19: Stop, Esc or the turn ending during a script or Shortcut cancels the run in the helper; a late result reads as stopped', async () => {
  for (const tool of ['desktop_app_script', 'desktop_shortcut_run']) {
    const r = AK.rig({
      saved: [
        { bundleId: AK.NOTES.bundleId, name: 'Notes', level: 'full' },
        { bundleId: 'com.apple.shortcuts', name: 'Shortcuts', level: 'full' },
      ],
    });
    let release: (v: any) => void = () => {};
    const slow = () => new Promise((res) => (release = res));
    r.helper.answers['app.script'] = (p: any) => (p.check ? READ : slow());
    r.helper.answers['shortcuts.run'] = slow;
    const method = tool === 'desktop_app_script' ? 'app.script' : 'shortcuts.run';
    const args = tool === 'desktop_app_script' ? { app: 'Notes', script: 'delay 60' } : { name: 'Long' };
    const running = r.call(tool, args);
    await waitFor(() => r.callsOf(method).some((c: any) => c.params.runId), 'the script run id');
    const runId = r.last(method).runId;
    r.apps.turnEnded('c1');
    assert.deepEqual(r.last('app.cancel'), { batchId: runId }, tool);
    release({ ok: true, output: 'late' });
    await assert.rejects(running, (e: any) => /stopped by the user/.test(e.message), tool);
  }
  // the helper ends the child on app.cancel with the run's id
  const helper = fs.readFileSync(new URL('../native/helper/Sources/ComputerUseHelper/Helper.swift', import.meta.url), 'utf8');
  assert.match(helper, /case "app.cancel":.*\n.*cancelAppRun\(id\)/);
  const script = fs.readFileSync(new URL('../native/helper/Sources/ComputerUseHelper/Script.swift', import.meta.url), 'utf8');
  assert.match(script, /func cancelAppRun\(_ id: String\) \{\n\s*cancelAppBatch\(id\)\n\s*cancelScriptRun\(id\)/);
});

test('CM-D20: the script and Shortcuts tools wait in the deferred desktop group app_script on every harness', () => {
  const names = ['desktop_app_script', 'desktop_shortcut_list', 'desktop_shortcut_run'];
  // Codex and ACP (a tiered list): hidden until the group loads, then listed
  const all = realSpecs();
  const hidden = tiers.tieredList(all, new Set()).map((t: any) => t.name);
  for (const n of names) assert.equal(hidden.includes(n), false, n);
  const more = tiers.moreTool('desktop', new Set(all.map((t: any) => t.name)));
  assert.match(more.description, /app_script \(AppleScript or JXA in one scriptable app, and the user's own Shortcuts\)/);
  const loaded = tiers.tieredList(all, new Set(['desktop/app_script'])).map((t: any) => t.name);
  for (const n of names) assert.ok(loaded.includes(n), n);
  // Claude Code: not core, so behind ToolSearch
  for (const n of names) assert.equal(CORE_HOST.mopilot_computer.includes(placement(n, 'sage_x').name), false, n);
});

test('CM-D22: a sparse window gets numbered OCR marks and element_index reaches them the same way on Claude, Codex, a switched chat and ACP', async () => {
  const { r, reg, claude } = world();
  const mark = (n: number, text: string) => ({ n, text, frame: { x: 120 + n * 50, y: 200, w: 40, h: 12 } });
  // the kit's window lists fewer than eight actionable elements: sparse
  r.helper.answers['app.marks'] = (p: any) => ({ jpeg: 'MARKED', marks: [mark(p.start, 'Inbox'), mark(p.start + 1, 'Send')] });
  const out = await claude('desktop_app_screenshot', { app: 'Notes' });
  assert.notEqual(out.isError, true, JSON.stringify(out));
  const text = out.content.map((c: any) => c.text || '').join('\n');
  assert.match(text, /Marks \[\d+\]-\[\d+\]: the accessibility list is sparse/);
  const n = Number(/\[(\d+)\] OCRText "Send"/.exec(text)?.[1]);
  assert.ok(n > 0, text);
  for (const [chatId, harness] of [
    ['c1', 'claude'],
    ['codex1', 'codex'],
    ['c1', 'codex'],
    ['acp1', 'acp:opencode'],
  ]) {
    r.cu.harness = () => harness;
    if (chatId !== 'c1') assert.equal((await reg.invoke(chatId, 's1', 'desktop_app_screenshot', { app: 'Notes' })).ok, true, harness);
    const res = await reg.invoke(chatId, 's1', 'desktop_app_click', { app: 'Notes', element_index: n });
    assert.equal(res.ok, true, `${harness}: ${JSON.stringify(res.error)}`);
    // the mark's center in global points: (120 + 50n + 20, 206)
    const c = r.last('app.click');
    assert.equal(c.y, 206, harness);
    assert.equal(c.id, undefined, harness);
    r.apps.releaseLocks(chatId);
  }
});
