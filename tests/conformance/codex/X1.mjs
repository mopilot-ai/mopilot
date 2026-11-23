// initialize, model/list (efforts, ultra gating, service tiers, default), collaboration modes, feature flags.
import { open } from '../lib/codex.mjs';

export const id = 'X1';
export const title = 'initialize, model/list efforts, service tiers, default model';
export const timeoutMs = 120000;

export default async function run(ctx) {
  const c = await open(ctx, 'session');
  const ml = await c.request('model/list', { includeHidden: true, limit: 100 });
  const models = (ml.result?.data ?? []).map((m) => ({
    id: m.id,
    hidden: m.hidden,
    isDefault: m.isDefault,
    efforts: (m.supportedReasoningEfforts ?? []).map((e) => e.reasoningEffort ?? e.effort ?? e),
    serviceTiers: (m.serviceTiers ?? []).map((t) => t.id),
    defaultServiceTier: m.defaultServiceTier ?? null,
  }));
  const modes = (await c.request('collaborationMode/list', {})).result;
  const features = (await c.request('experimentalFeature/list', {})).result?.data ?? [];
  const goals = features.find((f) => f.name === 'goals');
  const o = {
    initKeys: Object.keys(c.initResult ?? {}).sort(),
    userAgentHasVersion: String(c.initResult?.userAgent ?? '').includes(ctx.cliVersion),
    defaultModel: models.find((m) => m.isDefault)?.id ?? null,
    models,
    collaborationModes: (modes?.data ?? []).map((m) => m.mode ?? m.name),
    goalsFeature: goals ? { stage: goals.stage, defaultEnabled: goals.defaultEnabled } : null,
  };
  const probeModel = models.find((m) => m.id === ctx.model);
  return ctx.result(o, {
    'initialize has no version field; it is in userAgent': !o.initKeys.includes('version') && o.userAgentHasVersion,
    'one model is the default': !!o.defaultModel,
    'the probe model is listed': !!probeModel,
    'ultra is gated per model': models.some((m) => m.efforts.includes('ultra')) && models.some((m) => !m.efforts.includes('ultra')),
    'service tier is priority or nothing': models.every((m) => m.serviceTiers.every((t) => t === 'priority')),
    'collaboration modes include plan and default': o.collaborationModes.includes('plan') && o.collaborationModes.includes('default'),
    'goals feature flag is listed': !!goals,
  });
}
