// applyFlagSettings({ultracode}) and settings.ultracode, read back with the undeclared q.getSettings().
// No effort option here: an effort change without an ultracode key turns ultracode off.
import { open, brief, attachmentTypes, sleep } from '../lib/claude.mjs';

export const id = 'C6';
export const title = 'Query.applyFlagSettings / settings.ultracode';
export const timeoutMs = 400000;

const deny = async () => ({ behavior: 'deny', message: 'Denied by conformance test; answer in text.' });

export default async function run(ctx) {
  const o = {};
  const s = open(ctx, 'flags', { persist: true, effort: null, permissionMode: 'default', canUseTool: deny });
  await s.q.initializationResult();
  o.getSettingsType = typeof s.q.getSettings;
  const ultra = async () => (await s.q.getSettings())?.applied?.ultracode ?? null;
  o.available = (await s.q.getSettings())?.applied?.ultracodeAvailable ?? null;
  o.before = await ultra();
  await s.q.applyFlagSettings({ ultracode: true });
  o.afterOn = await ultra();
  o.turn = brief(await s.turn('Reply with the single word hi.', { origin: { kind: 'human' } }, 180000));
  await s.q.applyFlagSettings({ effortLevel: 'low' });
  o.afterEffortChange = await ultra();
  await s.q.applyFlagSettings({ ultracode: true });
  await s.q.applyFlagSettings({ ultracode: null });
  o.afterNull = await ultra();
  await sleep(300);
  o.attachments = attachmentTypes(s.sessionId());
  await s.close();

  const s2 = open(ctx, 'startSettings', { effort: null, settings: { ultracode: true }, permissionMode: 'default', canUseTool: deny });
  await s2.q.initializationResult();
  o.startedWithSetting = (await s2.q.getSettings())?.applied?.ultracode ?? null;
  await s2.close();

  return ctx.result(o, {
    'getSettings() exists at runtime': o.getSettingsType === 'function',
    'ultracode starts off': o.before === false,
    'applyFlagSettings({ultracode:true}) turns it on': o.afterOn === true,
    'next human turn gets ultra_effort_enter': o.attachments.includes('ultra_effort_enter'),
    'effort change without ultracode key turns it off': o.afterEffortChange === false,
    '{ultracode:null} clears it': o.afterNull === false,
    'settings.ultracode at start turns it on': o.startedWithSetting === true,
  });
}
