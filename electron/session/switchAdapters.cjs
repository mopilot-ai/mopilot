// Native-session preparation and activation for stable-chat switches on every harness family.
const crypto = require('node:crypto');
const { latestAcpSessionRecords } = require('../../shared/acpSessionRecords.mjs');
const { parseKind } = require('../../shared/harnessKind.mjs');
const { HARNESS_LABEL, SUMMARY_PROMPT } = require('../../shared/handoff.mjs');
const { segmentKey } = require('../platform/segmentOwner.cjs');
const { noteIgnored } = require('../ignored.cjs');
const { ISOLATED_THREAD } = require('../harness/codexIsolation.cjs');

const ADAPTERS = {
  codex: {
    turns: (r, _chatId, seg, _cwd, failed, hadTurns) => r.codexTurns(seg.nativeId, failed, hadTurns),
    cwd: async (r, ref) => {
      await r.codex.ensureResumed(ref.id).catch((error) => noteIgnored('resume the Codex thread to find its folder', error));
      return r.codex.cwdOf(ref.id) ?? (await r.fromRollout(ref.id))?.cwd ?? null;
    },
    summarize: (r, _chatId, ref) => r.codex.summarize(ref.id, SUMMARY_PROMPT),
    start: async (r, cwd, model, claim, chatId) => {
      const prefs = r.prefs();
      const isolated = r.isolated(chatId) ? { [ISOLATED_THREAD]: true } : {};
      const started = await r.codex.startThread(
        { ...isolated, cwd, model, ...r.permissionParams(prefs.permission), serviceTier: prefs.serviceTier },
        { onThread: claim },
      );
      return { nativeId: started.thread.id, fresh: false };
    },
  },
  claude: {
    turns: (r, chatId, seg, cwd, failed) => r.claudeTurns(chatId, seg.nativeId, cwd, failed),
    cwd: async (r, ref) => r.claude.cwdOf(ref),
    summarize: (r, chatId, ref, cwd) =>
      r.claude.summarize(ref.id, cwd, SUMMARY_PROMPT, r.prefs().claudeBin, r.claude.accountOf(chatId), chatId),
    start: async (r, cwd, _model, claim) => {
      const nativeId = crypto.randomUUID();
      claim(segmentKey('claude', nativeId));
      r.claude.registerSession(segmentKey('claude', nativeId), { cwd });
      return { nativeId, fresh: true };
    },
  },
  acp: {
    turns: (r, _chatId, seg, cwd, failed) => r.acpTurns(seg, cwd, failed),
    cwd: async (r, ref) => r.acpHost.chats.get(ref.key)?.cwd ?? (await r.acpHost.history(ref.key)).find((x) => x.t === 'session')?.cwd,
    // Generic ACP has no isolated summarization fork; the UI offers transcript handoff instead.
    summarize: null,
    start: (r, cwd, _model, claim, chatId, kind) => prepareAcp(r, kind, crypto.randomUUID(), cwd, claim, chatId),
    resume: (r, seg, cwd, claim, chatId) => prepareAcp(r, seg.kind, seg.nativeId, cwd, claim, chatId),
    activate: (r, prepared) => {
      const chat = prepared.chat;
      // session/new answers before the segment commits; publish its options again under the committed owner.
      r.acpHost.emitEvent({
        key: chat.key,
        kind: 'session',
        switched: true,
        sessionId: chat.sessionId,
        fresh: false,
        caps: chat.agent.caps,
        anchors: r.acpQuirks.describe(chat.harness)?.anchors ?? {},
        ...chat.state,
      });
    },
  },
};

async function prepareAcp(r, kind, nativeId, cwd, claim, chatId) {
  const key = segmentKey(kind, nativeId);
  claim(key);
  const chat = await r.acpHost.ensure(key, { cwd, chatId });
  // A prepared replacement can outlive a refused segment write or a restart. Its durable session record
  // does not establish conversation ownership until a prompt completed after it. Keep sending full context
  // until then, even when ensure now returns that replacement as a live or successfully loaded session.
  const records = await r.acpHost.history(key);
  let context = false;
  for (const record of latestAcpSessionRecords(records)) {
    if (record.t === 'end' && record.stopReason === 'end_turn' && !record.error) context = true;
  }
  return { nativeId, fresh: false, needsContext: !context, chat };
}

/** Unknown or malformed kinds never become valid switch destinations. */
function switchAdapter(kind) {
  const parsed = parseKind(kind);
  if (!parsed || parsed.basic === '' || String(kind).split(':').length > 2) return null;
  return ADAPTERS[parsed.family];
}

/** The user-visible name, supplied by ACP's adapter rather than its session-id spelling. */
function switchLabel(kind, quirks) {
  const basic = parseKind(kind)?.basic;
  return basic ? (quirks.describe(basic)?.label ?? basic) : (HARNESS_LABEL[kind] ?? 'another harness');
}

module.exports = { switchAdapter, switchLabel };
