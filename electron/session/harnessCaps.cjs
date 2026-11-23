// What a new chat on one harness gets in MoPilot once its session opens, for that harness's Settings page ("What works in MoPilot", #1385): the caps chats resolve, its family, and whether it can chat, whether its prompts take images and whether MoPilot's tools reach it.
const { flagsFor, negotiated } = require('./caps.cjs');
const { parseKind } = require('../../shared/harnessKind.mjs');

const OFF = 'Turned off by MoPilot for now.';
const NO_BRIDGE = "MoPilot's tools can't reach it right now: its tool bridge isn't running.";

/**
 * @typedef {{ chat: boolean, images: boolean | null, tools: boolean, toolsOff: string | null, toolsOffCode: 'tools.off' | 'tools.bridge' | null }} Works
 *   chat: a chat on it can run (it isn't switched off; a basic harness passed admission: handshake, privacy check, a session);
 *   images: its prompts take images (null: not known yet); tools: MoPilot's tools (messages to other chats, scheduled
 *   tasks, the browser and computer control) reach its sessions, and toolsOff why not
 * @typedef {{ channels(): Record<string, boolean> }} Health
 */

/**
 * @param {InstanceType<typeof import('./caps.cjs').CapsService>} service
 * @param {string} kind 'codex' | 'claude' | 'acp:<id>'
 * @param {{ list(): { id: string, state: string, catalog?: any, images?: boolean | null }[] } | null | undefined} admission
 *   the basic harnesses' admission (electron/harness/admission.cjs): state, the catalog its check's session offered, images
 * @param {Health | null | undefined} health the capability-health record (capabilityHealth.cjs): which families its tools reach
 * @returns {Promise<(NonNullable<Awaited<ReturnType<InstanceType<typeof import('./caps.cjs').CapsService>['get']>>> & { family: string, works: Works }) | null>}
 */
async function harnessCaps(service, kind, admission, health) {
  const k = parseKind(kind);
  const a = (k?.basic && admission?.list().find((h) => h.id === k.basic)) || null;
  const c = await service.get(null, { kind }, { acp: a?.catalog ?? null });
  if (!c || !k) return null;
  const flags = flagsFor(service.o.isEnabled ?? (() => true), {}, kind);
  const on = flags['sage.harness'] !== false;
  // a basic harness is admitted only once its session opened and MoPilot's tools answered in it
  const chat = on && (c.tier === 'first' || a?.state === 'admitted');
  // the tool channel carries the browser, computer control, messages to other chats and scheduled tasks alike
  const toolsOff = !on || flags['sage.channel'] === false ? OFF : health && !health.channels()[k.family] ? NO_BRIDGE : null;
  return {
    ...c,
    // which row of the per-harness control status (Settings → Computer use and Browser) is this harness's
    family: k.family,
    works: {
      chat,
      images: c.tier === 'first' ? negotiated(kind, {}).prompt.image.length > 0 : (a?.images ?? null),
      tools: chat && !toolsOff,
      toolsOff,
      toolsOffCode: toolsOff === OFF ? 'tools.off' : toolsOff === NO_BRIDGE ? 'tools.bridge' : null,
    },
  };
}

module.exports = { harnessCaps };
