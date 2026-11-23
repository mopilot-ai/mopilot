// Per-chat journal failures retire only that stream and its agent; failures remain observable without throwing into vendor event callbacks.
/** @param {{ hub: ReturnType<typeof import('./stream.mjs').createStreamHub>, cancel: (chatId: string) => unknown, report: (message: string) => void }} o */
export function createJournalFaults({ hub, cancel, report }) {
  const failed = new Map();
  const faults = {
    /** @param {string} chatId @param {unknown} error */
    fail(chatId, error) {
      const code =
        typeof (/** @type {any} */ (error)?.code) === 'string' && /** @type {any} */ (error).code.startsWith('session_journal_')
          ? /** @type {any} */ (error).code
          : 'session_journal_write_failed';
      const first = !failed.has(chatId);
      failed.set(chatId, code);
      hub.close(chatId, code);
      report(`Chat history could not be saved (${code}); its agent was stopped. Check this machine's disk space and permissions.`);
      if (first) {
        try {
          Promise.resolve(cancel(chatId)).catch(() => report('The agent could not be stopped after its journal failed.'));
        } catch {
          report('The agent could not be stopped after its journal failed.');
        }
      }
    },
    /** Catch storage faults at the vendor event boundary; never throw into an ACP/Codex/Claude callback. */
    listen(host, ownerOf, record, retire) {
      host.on('event', (event) => {
        const owner = ownerOf(event);
        try {
          record(event);
        } catch (error) {
          retire(event);
          if (owner) faults.fail(owner, error);
          else report('An unowned runtime event could not be saved.');
        }
      });
    },
    /** An answer may already have reached the native tool; a failed durable echo must not turn it into a retryable failed action. */
    answer(p, check, permit, record) {
      try {
        check(p.chatId);
      } catch (error) {
        faults.fail(p.chatId, error);
        throw error;
      }
      const answered = permit({ requestId: p.requestId, optionId: p.optionId, ...(p.form ? { form: p.form } : {}) });
      try {
        if (answered)
          record(p.chatId, {
            kind: 'permissionCancelled',
            requestId: p.requestId,
            ...(p.by ? { by: p.by } : {}),
          });
      } catch (error) {
        faults.fail(p.chatId, error);
        return { answered, journalError: 'session_journal_write_failed' };
      }
      return { answered };
    },
    /** Each recovery entry commits independently; a failed one keeps its run marker. */
    recover(left, commit) {
      let committed = 0;
      for (const [turnId, chatId] of left) {
        try {
          commit(turnId, chatId);
          committed++;
        } catch (error) {
          faults.fail(chatId, error);
        }
      }
      return committed;
    },
    /** @param {string} chatId */
    clear(chatId) {
      failed.delete(chatId);
    },
  };
  return faults;
}
