// The Host's `chat.remove`: a deleted chat is fenced, its turns and agent stop, and nothing of its content stays on this machine's disk (journal, record and transcript, agent session, uploads, waiting messages, handoff, request log); only what is not content stays, and why is listed in docs/host.md.
import { HostRefusal } from './hostFs.mjs';

/** The client the CLI on the Host's own machine acts as (hostClients.mjs): its uploads are kept under it too. */
export const LOCAL_CLI = 'local-cli';

/**
 * @param {object} o
 * @param {{ remove: (chatId: string) => void }} o.log the chat's journal (./chatLog.mjs)
 * @param {{ discardQueued?: (chatId: string) => void, retire?: (chatId: string) => Promise<void>, host: { cancel: (chatId: string) => unknown } }} o.runtime the chats' runtime (./sessions.mjs chatRuntime)
 * @param {{ chatCredentials: { forget: (chatId: string) => void } } | null | undefined} o.ownRuns
 * @param {{ forget: (chatId: string) => void }} o.approvals
 * @param {{ forget: (chatId: string) => void } | undefined} o.spend
 * @param {{ delete: (chatId: string) => unknown }} o.groups the text a chat is streaming
 * @param {{ forget: (chatId: string) => void }} o.output the live output of a chat's commands
 * @param {Map<string, { key: string }>} o.turns the turns running, by turn id
 * @param {{ end: (turnId: string) => void } | undefined} o.journal
 * @param {{ abortChat: (chatId: string) => void } | null | undefined} o.tools
 * @param {{ forgetChat: (chatId: string, owners: string[]) => Promise<void> } | undefined} o.images the uploads, by client and chat (./chatImages.mjs)
 * @param {{ done: (chatId: string) => void } | undefined} o.handoffs the handoff a continued chat's first message carries
 * @param {{ clients?: (chatId: string) => string[], retire?: (chatId: string, keepKey: string) => void }} o.guard the request log (./ledger.mjs)
 * @param {() => string[]} [o.clients] every client this Host has paired: a deleted chat's uploads of each go
 * @param {(message: string) => void} o.report
 * @returns {(p: { chatId: string, key: string }) => Promise<{ removed: true }>}
 */
export function createChatRemoval({
  log,
  runtime,
  ownRuns,
  approvals,
  spend,
  groups,
  output,
  turns,
  journal,
  tools,
  images,
  handoffs,
  guard,
  clients,
  report,
}) {
  return async (p) => {
    log.remove(p.chatId);
    ownRuns?.chatCredentials.forget(p.chatId);
    approvals.forget(p.chatId);
    spend?.forget(p.chatId);
    runtime.discardQueued?.(p.chatId);
    groups.delete(p.chatId);
    output.forget(p.chatId);
    for (const [id, turn] of turns)
      if (turn.key === p.chatId) {
        try {
          journal?.end(id);
        } catch {
          report('A deleted chat kept a stale run marker; restart recovery will clear it without replay.');
        }
        turns.delete(id);
      }
    tools?.abortChat(p.chatId);
    try {
      await runtime.host.cancel(p.chatId);
    } catch {
      report('A deleted chat could not stop its agent; late output is fenced.');
    }
    // the agent has stopped: what it and the clients stored for the chat goes now. Each step is safe to run again, so one that fails is said and the rest still run.
    /** @type {string[]} */
    const failed = [];
    const step = async (/** @type {string} */ what, /** @type {() => unknown} */ run) => {
      try {
        await run();
      } catch (error) {
        report(`A deleted chat's ${what} could not be removed: ${/** @type {Error} */ (error).message}`);
        failed.push(what);
      }
    };
    await step('record and agent session', () => runtime.retire?.(p.chatId));
    // the clients that stored uploads for the chat: those paired now and those the request log names (one removed since still has its files)
    await step('uploads', () =>
      images?.forgetChat(p.chatId, [...new Set([LOCAL_CLI, ...(clients?.() ?? []), ...(guard.clients?.(p.chatId) ?? [])])]),
    );
    await step('handoff', () => handoffs?.done(p.chatId));
    // last, and only once every step before it is done: the log names the clients whose uploads a retry must still find, and its own entry is what answers this deletion when it is sent again
    if (!failed.length) await step('request log', () => guard.retire?.(p.chatId, p.key));
    if (failed.length)
      throw new HostRefusal(
        'session_journal_delete_failed',
        `This machine could not delete the chat's ${failed.join(', ')}. Retry, or check its disk space and permissions.`,
      );
    return { removed: true };
  };
}
