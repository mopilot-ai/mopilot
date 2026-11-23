// Plan mode mid-session: setPermissionMode('plan'), ExitPlanMode through canUseTool, approve with setMode.
// plansDirectory points into the temp dir so the plan file is not written under ~/.claude.
import fs from 'node:fs';
import { open, brief, toolUses, sleep } from '../lib/claude.mjs';

export const id = 'C7';
export const title = 'Plan mode round trip';
export const timeoutMs = 400000;

const RETURN_MODE = 'acceptEdits';

export default async function run(ctx) {
  const cwd = ctx.cwd('plan');
  const calls = [];
  const s = open(ctx, 'session', {
    cwd,
    permissionMode: 'default',
    settings: { plansDirectory: ctx.cwd('plans') },
    canUseTool: async (name, input) => {
      calls.push({ name, inputKeys: Object.keys(input ?? {}) });
      if (name === 'ExitPlanMode')
        return {
          behavior: 'allow',
          updatedInput: input,
          updatedPermissions: [{ type: 'setMode', mode: RETURN_MODE, destination: 'session' }],
        };
      return { behavior: 'allow', updatedInput: input };
    },
  });
  const modes = (from) =>
    s
      .since(from)
      .filter((m) => m.type === 'system' && m.subtype === 'status' && m.permissionMode)
      .map((m) => m.permissionMode);
  const o = { calls };
  await s.turn('Reply with just ok.', {}, 120000);
  let i0 = s.msgs.length;
  await s.q.setPermissionMode('plan');
  await sleep(1500);
  o.statusAfterSetPlan = modes(i0);
  i0 = s.msgs.length;
  const r = await s.turn(
    'Task: create a file hello.txt in the current directory containing the line hello. You are in plan mode: write a 2-line plan and present it with ExitPlanMode. After approval, create the file.',
    {},
    240000,
  );
  await sleep(1000);
  o.planTurn = { result: brief(r), tools: toolUses(s.since(i0)), statusModes: modes(i0) };
  o.fileCreated = fs.existsSync(`${cwd}/hello.txt`);
  i0 = s.msgs.length;
  await s.turn('Reply with just ok.', {}, 120000);
  o.nextInitMode = s.since(i0).find((m) => m.subtype === 'init')?.permissionMode;
  i0 = s.msgs.length;
  await s.q.setPermissionMode('default');
  await sleep(1000);
  o.statusAfterSetDefault = modes(i0);
  const exit = calls.find((c) => c.name === 'ExitPlanMode');
  return ctx.result(o, {
    'setPermissionMode(plan) emits status plan': o.statusAfterSetPlan.includes('plan'),
    'ExitPlanMode reaches canUseTool with plan input': !!exit && exit.inputKeys.includes('plan'),
    'setMode in updatedPermissions switches mode': o.planTurn.statusModes.includes(RETURN_MODE),
    'the model executes after approval': o.fileCreated,
    'next init reports the returned mode': o.nextInitMode === RETURN_MODE,
    'setPermissionMode(default) emits status default': o.statusAfterSetDefault.includes('default'),
  });
}
