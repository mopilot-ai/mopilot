// A profile shaped like a long-time user's (2026-10-30 sample): 750 chat records (365 Claude Code, 387 Codex), about
// 1.3 GB of Claude Code transcripts in 331 sessions (a few over 100 MB) plus 1.1 GB of sub-agent transcripts, and the Codex
// threads the fake app-server lists. Synthetic content only; written by the startup heap journeys before the app starts.
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Seed } from './app';

const MB = 1024 * 1024;

/** Session sizes in MB, largest first: as the sample's top-level transcripts were distributed. */
export function sessionSizes(scale = 1): number[] {
  const sizes = [...Array(3).fill(110), ...Array(9).fill(30), ...Array(238).fill(3), ...Array(81).fill(0.3)];
  return sizes.map((s) => s * scale);
}

const filler = (n: number) => 'lorem ipsum dolor sit amet, consectetur adipiscing elit. '.repeat(Math.ceil(n / 57)).slice(0, n);

/** Writes one Claude Code transcript of about `bytes`: turns of a prompt, a tool call, its (large) result and a reply. */
function writeTranscript(file: string, id: string, cwd: string, bytes: number, t0: number) {
  const fd = fs.openSync(file, 'w');
  let parentUuid: string | null = null;
  let t = t0;
  let written = 0;
  let turn = 0;
  const line = (type: string, extra: object) => {
    const uuid = randomUUID();
    const s = `${JSON.stringify({ parentUuid, isSidechain: false, userType: 'external', cwd, sessionId: id, version: '2.1.309', gitBranch: 'main', type, uuid, timestamp: new Date((t += 1000)).toISOString(), ...extra })}\n`;
    parentUuid = uuid;
    fs.writeSync(fd, s);
    written += s.length;
  };
  while (written < bytes) {
    turn++;
    line('user', { message: { role: 'user', content: `request ${turn}: ${filler(200)}` } });
    for (let k = 0; k < 4; k++) {
      if (written >= bytes) break;
      const toolId = `toolu_${randomUUID().replace(/-/g, '')}`;
      line('assistant', {
        message: {
          id: `msg_${turn}_${k}`,
          role: 'assistant',
          model: 'claude-opus-5-5',
          content: [{ type: 'tool_use', id: toolId, name: 'Bash', input: { command: `cat file${k}.txt` } }],
          usage: { input_tokens: 10, output_tokens: 10 },
        },
      });
      line('user', {
        message: {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: toolId, content: filler(4000 + ((turn * 7919 + k * 104729) % 24000)) }],
        },
        toolUseResult: { stdout: filler(2000), stderr: '' },
      });
    }
    line('assistant', {
      message: {
        id: `msg_${turn}_r`,
        role: 'assistant',
        model: 'claude-opus-5-5',
        content: [{ type: 'text', text: filler(800) }],
        usage: { input_tokens: 10, output_tokens: 10 },
      },
    });
  }
  fs.closeSync(fd);
}

/**
 * The seed: chat records, Claude transcripts (and sub-agent sidecars) under the profile's CLAUDE_CONFIG_DIR, and the fake
 * Codex's threads. `scale` shrinks every transcript for a quick run.
 */
export function heavyProfile(scale = 1): { seed: Seed; claudeIds: string[] } {
  const sizes = sessionSizes(scale);
  const claudeIds = Array.from({ length: 365 }, () => randomUUID());
  const codexIds = Array.from({ length: 387 }, () => randomUUID());
  const now = Date.now();
  const meta = {
    archived: null,
    pinned: false,
    unread: false,
    projectId: null,
    worktreeOf: null,
    account: null,
    config: null,
    goalHeld: null,
    notes: [],
    computerGrants: [],
    navigationBookmarks: [],
  };
  const record = (id: string, kind: string, nativeId: string, i: number) => ({
    schemaVersion: 2,
    id,
    segments: [{ kind, nativeId, instance: null, provider: null, model: null, handoff: null, start: 0, count: null }],
    meta,
    updatedAt: now - i * 3_600_000,
  });
  const threads: Record<string, unknown> = {};
  claudeIds.forEach((id, i) => (threads[`${encodeURIComponent(`claude:${id}`)}.v2`] = record(`claude:${id}`, 'claude', id, i)));
  codexIds.forEach((id, i) => (threads[`${id}.v2`] = record(id, 'codex', id, i)));
  const seed: Seed = {
    threads,
    codexThreads: codexIds.map((id) => ({ id, name: `codex chat ${id.slice(0, 6)}`, turns: ['an old request'] })),
    files: ({ home, claudeHome }) => {
      sizes.forEach((mb, i) => {
        const id = claudeIds[i];
        const cwd = path.join(home, 'projects', `p${i % 120}`);
        fs.mkdirSync(cwd, { recursive: true });
        const dir = path.join(claudeHome, 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'));
        fs.mkdirSync(dir, { recursive: true });
        // the session's last write is its chat record's updatedAt, so the largest transcripts are the newest rows, as a
        // long-time user's current work is
        const last = now - i * 3_600_000;
        const t0 = last - 3_600_000;
        const file = path.join(dir, `${id}.jsonl`);
        writeTranscript(file, id, cwd, mb * MB, t0);
        fs.utimesSync(file, last / 1000, last / 1000);
        // 1967 sub-agent transcripts of ~575 KB, spread over the sessions
        const subs = Math.round(1967 / sizes.length) + (i < 1967 % sizes.length ? 1 : 0);
        if (subs) fs.mkdirSync(path.join(dir, id, 'subagents'), { recursive: true });
        for (let k = 0; k < subs; k++) {
          const agent = `a${randomUUID().replace(/-/g, '').slice(0, 16)}`;
          writeTranscript(path.join(dir, id, 'subagents', `agent-${agent}.jsonl`), id, cwd, 0.56 * MB * scale, t0);
        }
      });
    },
  };
  return { seed, claudeIds };
}
