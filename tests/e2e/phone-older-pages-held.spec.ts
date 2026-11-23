// A phone paging back through a long chat is answered from rows the Mac made once (#5379): the app's real page producer, history reader, Claude transcript reader and Codex rollout reader (in its own process), on a long Claude transcript and a long Codex rollout. Pages equal a read-per-page walk's; the history is read a handful of times instead of once per page.
import fs from 'node:fs';
import path from 'node:path';
import { test, expect } from './fixtures/app';
import { transcriptRecords, uuidOf } from '../support/claudeTranscriptFixture';

test.use({ harnesses: 'both' });
test.describe.configure({ timeout: 6 * 60_000 });

const PAGES = 60;
const LIMIT = 40;
const CLAUDE_ID = uuidOf(0x5379);
const pad = (n: number) => String(n).padStart(2, '0');

/** A Codex thread id (UUIDv7): its first 48 bits are when it was made, and name the rollout's date folder. */
const at = new Date();
const CODEX_ID = `${at
  .getTime()
  .toString(16)
  .padStart(12, '0')
  .replace(/^(.{8})(.{4})$/, '$1-$2')}-7000-8000-000000005379`;

/** A rollout with `n` turns of one user message each. */
function rollout(n: number) {
  const out: object[] = [{ type: 'session_meta', payload: { id: CODEX_ID, cwd: '/work' } }];
  for (let i = 0; i < n; i++) {
    const turn = `t${i}`;
    out.push({ type: 'event_msg', payload: { type: 'task_started', turn_id: turn, started_at: i } });
    out.push({
      type: 'event_msg',
      payload: {
        type: 'item_completed',
        turn_id: turn,
        item: { type: 'UserMessage', id: `u${i}`, content: [{ type: 'text', text: `message ${i} ${'x'.repeat(600)}` }] },
      },
    });
    out.push({ type: 'event_msg', payload: { type: 'task_complete', turn_id: turn, completed_at: i + 1, duration_ms: 1000 } });
  }
  return `${out.map((r) => JSON.stringify(r)).join('\n')}\n`;
}

test('paging a long Claude or Codex chat back reads its history a few times, not once per page, and gives the pages a read per page gives', async ({
  harness,
}) => {
  // a long Claude Code transcript under the app's CLAUDE_CONFIG_DIR, and a long Codex rollout under its CODEX_HOME
  const projects = path.join(harness.env.CLAUDE_CONFIG_DIR, 'projects', '-work');
  fs.mkdirSync(projects, { recursive: true });
  fs.writeFileSync(
    path.join(projects, `${CLAUDE_ID}.jsonl`),
    `${[...transcriptRecords({ sessionId: CLAUDE_ID, turns: 2000, toolsPerTurn: 2, resultBytes: 1500 })].map((r) => JSON.stringify(r)).join('\n')}\n`,
  );
  const day = path.join(harness.env.CODEX_HOME, 'sessions', String(at.getFullYear()), pad(at.getMonth() + 1), pad(at.getDate()));
  fs.mkdirSync(day, { recursive: true });
  fs.writeFileSync(
    path.join(day, `rollout-${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}T12-00-00-${CODEX_ID}.jsonl`),
    rollout(2000),
  );

  const entry = path.resolve(__dirname, '../../electron/app/chromePanelOlder.cjs');
  const walks = await harness.app.evaluate(
    async (_electron, { entry, kinds, pages, limit }) => {
      const require = process.getBuiltinModule('module').createRequire(entry);
      const { createPanelOlder } = require('./chromePanelOlder.cjs');
      const { createPanelRowsCache } = require('./panelRowsCache.cjs');
      const { createHistoryReader } = require('./chromePanelHistory.cjs');
      const { createPeerNativeReader, claudePeerSource } = require('../session/peerNativeHistory.cjs');
      const { peerHistoryReader } = require('../session/peerTranscript.cjs');
      const { createState } = require('../harness/claude/state.cjs');
      const { createTranscripts } = require('../harness/claude/transcripts.cjs');
      const { codexRollouts } = require('../harness/codexRollout.cjs');
      const { recentRowsOf } = require('../capabilities/browser/chromePanelLive.cjs');
      const state = createState();
      const transcripts = createTranscripts({ sdk: state.sdk, resumeAt: new Map() }, null);
      const source = claudePeerSource(transcripts);
      const reads = { claude: 0, codex: 0 };
      const reader = createPeerNativeReader({
        ...source,
        claudeRecent: async (...a: any[]) => (reads.claude++, source.claudeRecent(...a)),
        claudeTurns: async (...a: any[]) => (reads.claude++, source.claudeTurns(...a)),
        acpTurns: async () => ({ turns: [] }),
        // the app-server is not asked: a Codex chat is read from its rollout file, the way the app reads it while the server is down
        codexTurns: async () => {
          throw new Error('app-server down');
        },
        codexRollout: async (id: string) => (reads.codex++, codexRollouts().history(id)),
      });
      const walk = async (kind: 'claude' | 'codex', nativeId: string, held: boolean) => {
        const records = new Map<string, any>([['c', { meta: {}, segments: [{ kind, nativeId }] }]]);
        const live: any = { chats: { records } };
        live.peerRuntime = { readHistory: peerHistoryReader(live.chats, () => reader) };
        const historyOf = createHistoryReader(live);
        // the reader before this change named no stamp, so each page read the history again
        if (!held) delete (historyOf as any).stamp;
        const older = createPanelOlder({ live, reachable: () => true, historyOf, cache: createPanelRowsCache() });
        const whole = await historyOf('c', records.get('c'));
        let before: string | undefined = (recentRowsOf(whole.turns, {}).rows[0] as any).id;
        reads.claude = reads.codex = 0;
        const ids: string[] = [];
        const times: number[] = [];
        while (before && times.length < pages) {
          const t0 = performance.now();
          const page = await older('c', before, limit);
          times.push(performance.now() - t0);
          if (!page) throw new Error(`the row ${before} is gone`);
          ids.push(...page.rows.map((r: any) => `${r.id}:${page.more}`));
          if (!page.more) break;
          before = page.rows[0].id;
        }
        return { ids, times, reads: reads[kind], stamped: held };
      };
      const out: Record<string, any> = {};
      for (const [kind, nativeId] of kinds as [string, string][]) {
        // Claude's own text ids and Codex's are made per read: the walks are compared by their rows' ids
        const fresh = await walk(kind as any, nativeId, false);
        const held = await walk(kind as any, nativeId, true);
        out[kind] = { fresh, held };
      }
      return out;
    },
    {
      entry,
      kinds: [
        ['claude', CLAUDE_ID],
        ['codex', CODEX_ID],
      ],
      pages: PAGES,
      limit: LIMIT,
    },
  );

  const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
  for (const kind of ['claude', 'codex']) {
    const { fresh, held } = walks[kind];
    const line = `${kind}: ${held.times.length} pages; per-page read ${sum(fresh.times).toFixed(0)} ms (${fresh.reads} history reads), held ${sum(held.times).toFixed(0)} ms (${held.reads} history reads)`;
    console.log(line);
    test.info().annotations.push({ type: `older pages, ${kind}`, description: line });
    expect(held.ids.length, `${kind}: the walk got pages`).toBeGreaterThan(LIMIT);
    expect(held.ids, `${kind}: the held pages are the pages a read per page gives`).toEqual(fresh.ids);
    expect(fresh.reads, `${kind}: without the stamp the history is read for every page`).toBeGreaterThanOrEqual(fresh.times.length);
    expect(held.reads, `${kind}: with it the history is read a handful of times`).toBeLessThanOrEqual(8);
  }
});
