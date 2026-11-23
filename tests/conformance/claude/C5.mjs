// origin {kind:"human"} is accepted and gates the "ultracode" keyword; unknown commands fall back to the model.
import { open, brief, transcript, toolUses } from '../lib/claude.mjs';

export const id = 'C5';
export const title = 'origin {kind:"human"} and the ultracode keyword';
export const timeoutMs = 600000;

const deny = async () => ({ behavior: 'deny', message: 'Denied by conformance test; just answer in text.' });

export default async function run(ctx) {
  const out = {};
  for (const label of ['noOrigin', 'human']) {
    const extra = label === 'human' ? { origin: { kind: 'human' } } : {};
    const s = open(ctx, label, { persist: true, permissionMode: 'default', canUseTool: deny });
    const ultra = await s.turn('ultracode: do not do any real work, just reply with the single word hi.', extra, 180000);
    const unknown = await s.turn('/sage-codex-skill-xyz please summarise nothing', extra, 120000);
    const recs = transcript(s.sessionId());
    out[label] = {
      ultracode: brief(ultra),
      unknownCommand: brief(unknown),
      toolUses: toolUses(s.msgs),
      attachments: recs.filter((r) => r.type === 'attachment').map((r) => r.attachment?.type),
      userOrigins: recs.filter((r) => r.type === 'user' && !r.isMeta).map((r) => r.origin?.kind ?? null),
    };
    await s.close();
  }
  const { human, noOrigin } = out;
  return ctx.result(out, {
    'origin human is persisted on the user record': human.userOrigins.includes('human'),
    'ultracode keyword triggers with origin human': human.attachments.includes('workflow_keyword_request'),
    'ultracode keyword does not trigger without origin': !noOrigin.attachments.includes('workflow_keyword_request'),
    'unknown command falls back to the model (both)': [human, noOrigin].every(
      (o) => o.attachments.includes('unknown_command_fallback') && o.unknownCommand?.num_turns >= 1 && !o.unknownCommand?.is_error,
    ),
  });
}
