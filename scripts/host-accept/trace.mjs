// `--trace <dir>`: what a failing step leaves for a person to read. Every wire frame of the step with its time (requests, replies, events), the journal of each chat it touched read afresh from revision 0, and the Host's own log lines for those chats, in one JSON-lines file per step. The content is the run's own prompts, so it may be kept.
import fs from 'node:fs';
import path from 'node:path';

/**
 * @param {object} o
 * @param {string} o.dir where the files go @param {typeof fs} [o.fs] @param {() => number} [o.now]
 * @param {number} [o.settleMs] how long a fresh client listens to a chat's replay
 */
export function createTrace({ dir, fs: files = fs, now = Date.now, settleMs = 1500 }) {
  let cell = '';
  let began = 0;
  let clients = 0;
  /** @type {{ t: number, client: number, dir: 'out' | 'in', msg: any }[]} */
  let entries = [];
  /** @type {Set<string>} */
  let chats = new Set();
  /** @type {string[]} */
  const written = [];
  return {
    /** A new step starts: what was seen before is not its. @param {string} id */
    begin(id) {
      cell = id;
      began = now();
      entries = [];
      chats = new Set();
    },
    /** The tap of one connection: each message sent or received, as the client sees it. */
    tapFor() {
      const client = ++clients;
      return (/** @type {'out' | 'in'} */ dir, /** @type {any} */ msg) => {
        entries.push({ t: now() - began, client, dir, msg });
        const chatId = msg?.chatId ?? msg?.params?.chatId;
        if (typeof chatId === 'string') chats.add(chatId);
      };
    },
    /**
     * Write the failed step's file. Never throws: what went wrong while tracing is in the note it returns.
     * @param {any} ctx @param {string} message the step's failure
     * @param {{ session: (ctx: any) => Promise<any> }} deps
     * @returns {Promise<string>} a note for the report row
     */
    async finish(ctx, message, deps) {
      /** @type {Record<string, unknown>[]} */
      const lines = [{ kind: 'cell', cell, message, startedAt: new Date(began).toISOString(), chats: [...chats] }];
      for (const e of entries) lines.push({ kind: 'frame', ...e });
      for (const chatId of chats) {
        try {
          const c = await deps.session(ctx);
          try {
            await c.request('chat.subscribe', { chatId, epoch: 1, fromRev: 0 });
            await new Promise((r) => setTimeout(r, settleMs));
            lines.push({ kind: 'journal', chatId, items: c.events.filter((/** @type {any} */ e) => e.chatId === chatId) });
          } finally {
            c.close();
          }
        } catch (e) {
          lines.push({ kind: 'journalError', chatId, error: /** @type {Error} */ (e).message });
        }
      }
      if (ctx.state.dataDir) {
        const log = await ctx.m.run(
          `tail -n 2000 '${ctx.state.dataDir}/host.log' 2>/dev/null; journalctl --user -u mopilot-host --no-pager -n 2000 2>/dev/null`,
        );
        const all = log.stdout.split('\n').filter(Boolean);
        lines.push({
          kind: 'hostLog',
          forChats: all.filter((l) => [...chats].some((id) => l.includes(id))),
          // the Codex stop path's own lines (host/src: `[codex-stop]`), whatever chat they name
          stop: all.filter((l) => l.includes('[codex-stop]')),
          tail: all.slice(-150),
        });
      }
      const file = path.join(dir, `${cell.replace(/[^A-Za-z0-9._-]/g, '_')}.jsonl`);
      try {
        files.mkdirSync(dir, { recursive: true });
        files.writeFileSync(file, `${lines.map((l) => JSON.stringify(l)).join('\n')}\n`);
        written.push(file);
        return ` [trace: ${file}]`;
      } catch (e) {
        return ` [trace not written: ${/** @type {Error} */ (e).message}]`;
      }
    },
    /** The files written, for the report's end. */
    files: () => [...written],
  };
}

/** The report's closing lines about traces, or nothing. @param {any} ctx */
export const traceSummary = (ctx) => {
  const files = ctx.trace?.files() ?? [];
  return files.length ? `\n**Traces:**\n${files.map((f) => `- ${f}`).join('\n')}\n` : '';
};
