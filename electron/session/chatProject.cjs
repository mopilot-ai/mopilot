// A chat's project folder, read from its harness's native session without blocking the main process (for peer
// messaging, PR monitoring, the scheduled-task tool and dev-server previews).
const { parseKind } = require('../../shared/harnessKind.mjs');
const { noteIgnored } = require('../ignored.cjs');

/** How many times a chat that switched segment while its folder was read is read again before it reads unknown. */
const PROJECT_READS = 3;

/**
 * @param {{ chats: () => { records: Map<string, any>, record: (id: string) => { segments: { kind: string, nativeId: string }[] } },
 *           codexCwd: (threadId: string) => Promise<string | null>, claudeCwd: (ref: { key: string, id: string }) => Promise<string | null>,
 *           acpCwd: (key: string) => string | null | undefined, acpHistory: (key: string) => Promise<any[]> }} o
 *   chats: the chat store (read when asked); codexCwd: CodexAdapter.folderOf; claudeCwd: ClaudeAdapter.cwdOf; acpCwd: the running session's;
 *   acpHistory: the chat's transcript records (AcpHost.history)
 */
function createChatProjects(o) {
  /**
   * Each family's project folder for a segment, read without activating a window or switching the target's harness.
   * @type {Record<import('../../shared/harnessKind.mjs').HarnessFamily, (seg: { kind: string, nativeId: string }, key: string) => Promise<string | null>>}
   */
  const PROJECT = {
    codex: (seg) => o.codexCwd(seg.nativeId),
    claude: (seg, key) => o.claudeCwd({ key, id: seg.nativeId }),
    acp: async (_seg, key) => o.acpCwd(key) ?? (await o.acpHistory(key)).find((r) => r.t === 'session')?.cwd ?? null,
  };
  /** A segment's project folder (a segment keeps its folder), or null for a harness MoPilot doesn't know. */
  async function peerProject(seg) {
    const family = parseKind(seg.kind)?.family;
    return family ? PROJECT[family](seg, `${seg.kind}:${seg.nativeId}`) : null;
  }
  /**
   * The project folder of the chat's current segment (what controller.ref names; a chat with no record yet names its
   * first) when the read ends, or null: a chat that switched harness while its folder was read is read again, and one
   * deleted meanwhile has none.
   * @param {string} chatId
   * @returns {Promise<string | null>}
   */
  async function chatProject(chatId) {
    const saved = o.chats().records.has(chatId);
    const segOf = () => (saved && !o.chats().records.has(chatId) ? null : o.chats().record(chatId).segments.at(-1));
    try {
      let seg = segOf();
      for (let read = 0; seg && read < PROJECT_READS; read++) {
        const project = await peerProject(seg);
        const now = segOf();
        if (now && now.kind === seg.kind && now.nativeId === seg.nativeId) return project || null;
        seg = now;
      }
    } catch (error) {
      noteIgnored("read a chat's project folder", error);
    }
    return null;
  }
  return { peerProject, chatProject };
}

module.exports = { createChatProjects, PROJECT_READS };
