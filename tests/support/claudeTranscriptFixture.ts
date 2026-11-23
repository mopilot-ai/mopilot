// A synthetic Claude Code transcript on disk, in the CLI's JSONL shape (prompts, tool calls and their results, replies, and the lines about the session between them), small or tens of megabytes, for tests of how it is read.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** A uuid that sorts and reads: `n` as the last twelve hex digits. */
export const uuidOf = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;

export type FixtureOptions = {
  sessionId: string;
  /** How many turns (each a prompt, `toolsPerTurn` tool calls with results, and a reply). */
  turns: number;
  toolsPerTurn?: number;
  /** The size of each tool result's text, in bytes. */
  resultBytes?: number;
  cwd?: string;
  /** Turns whose first tool result carries the end-turn flag (the SDK's reader drops it, so a read puts it back). */
  endTurnAt?: number[];
  /** Turns that end with a hook notice, a line the SDK's reader drops and a read puts back. */
  noticeAt?: number[];
  /**
   * Turns that end with a background task's notification, naming the tool call of turn `launchedAt` as the one that launched the
   * task: as the user text the CLI writes (`text`), or as the SDK's system message (`system`).
   */
  /** Turns that end with a compaction boundary (the CLI's `compact_boundary` system line, which starts the chain the SDK reads). */
  compactAt?: number[];
  notifications?: { turn: number; launchedAt: number; via?: 'text' | 'system' }[];
};

/** The transcript's lines, one JSON record each, linked by parentUuid the way the CLI writes them. */
export function* transcriptRecords({
  sessionId,
  turns,
  toolsPerTurn = 2,
  resultBytes = 400,
  cwd = '/work',
  endTurnAt = [],
  noticeAt = [],
  notifications = [],
  compactAt = [],
}: FixtureOptions): Generator<Record<string, unknown>> {
  let n = 0;
  let parent: string | null = null;
  const at = (i: number) => new Date(Date.UTC(2026, 0, 1) + i * 1000).toISOString();
  const base = (type: string, uuid: string, message: unknown, extra: Record<string, unknown> = {}) => ({
    parentUuid: parent,
    isSidechain: false,
    userType: 'external',
    cwd,
    sessionId,
    version: '2.1.0',
    gitBranch: 'main',
    type,
    message,
    uuid,
    timestamp: at(n),
    ...extra,
  });
  const body = 'x'.repeat(resultBytes);
  for (let t = 0; t < turns; t++) {
    // a line about the session between turns, as the CLI writes titles and modes
    yield { type: 'mode', mode: 'default', sessionId };
    let uuid = uuidOf(++n);
    yield base('user', uuid, { role: 'user', content: `prompt ${t}` });
    parent = uuid;
    for (let k = 0; k < toolsPerTurn; k++) {
      const call = `toolu_${t}_${k}`;
      uuid = uuidOf(++n);
      yield base(
        'assistant',
        uuid,
        {
          id: `msg_${t}_${k}`,
          type: 'message',
          role: 'assistant',
          model: 'claude-test',
          content: [{ type: 'tool_use', id: call, name: 'Bash', input: { command: `echo ${t} ${k}` } }],
          stop_reason: 'tool_use',
          usage: { input_tokens: 1, output_tokens: 1 },
        },
        { requestId: `req_${t}_${k}` },
      );
      parent = uuid;
      uuid = uuidOf(++n);
      yield base(
        'user',
        uuid,
        { role: 'user', content: [{ tool_use_id: call, type: 'tool_result', content: `result ${t} ${k} ${body}` }] },
        {
          toolUseResult: { stdout: `result ${t} ${k}`, stderr: '' },
          ...(k === 0 && endTurnAt.includes(t) ? { mcpMeta: { _meta: { 'claude/endTurn': true } } } : {}),
        },
      );
      parent = uuid;
    }
    uuid = uuidOf(++n);
    yield base('assistant', uuid, {
      id: `msg_${t}_end`,
      type: 'message',
      role: 'assistant',
      model: 'claude-test',
      content: [{ type: 'text', text: `reply ${t}` }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 1, output_tokens: 1 },
    });
    parent = uuid;
    if (compactAt.includes(t)) {
      uuid = uuidOf(++n);
      yield {
        parentUuid: null,
        logicalParentUuid: parent,
        isSidechain: false,
        sessionId,
        type: 'system',
        subtype: 'compact_boundary',
        content: 'Conversation compacted',
        compactMetadata: { trigger: 'auto', preTokens: 1000 },
        uuid,
        timestamp: at(n),
      };
      parent = uuid;
    }
    for (const note of notifications.filter((x) => x.turn === t)) {
      uuid = uuidOf(++n);
      const launch = `toolu_${note.launchedAt}_0`;
      yield note.via === 'system'
        ? {
            parentUuid: parent,
            isSidechain: false,
            sessionId,
            type: 'system',
            subtype: 'task_notification',
            task_id: 'bg1',
            tool_use_id: launch,
            status: 'completed',
            summary: 'Background command finished',
            uuid,
            timestamp: at(n),
          }
        : base('user', uuid, {
            role: 'user',
            content: `<task-notification>\n<task-id>bg1</task-id>\n<tool-use-id>${launch}</tool-use-id>\n<status>completed</status>\n<summary>Background command finished</summary>\n</task-notification>`,
          });
      parent = uuid;
    }
    if (noticeAt.includes(t)) {
      uuid = uuidOf(++n);
      yield {
        parentUuid: parent,
        isSidechain: false,
        sessionId,
        type: 'system',
        subtype: 'informational',
        content: `notice ${t}`,
        level: 'info',
        uuid,
        timestamp: at(n),
      };
      parent = uuid;
    }
  }
}

/**
 * Writes the transcript under a config folder as the CLI keeps it (`projects/<folder>/<session>.jsonl`) and points the SDK at it
 * (CLAUDE_CONFIG_DIR). Returns where it is, and what to call when the test is done.
 */
export function writeTranscript(options: FixtureOptions): { file: string; dir: string; size: number; done: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-fixture-'));
  const folder = path.join(dir, 'projects', '-work');
  fs.mkdirSync(folder, { recursive: true });
  const file = path.join(folder, `${options.sessionId}.jsonl`);
  const fd = fs.openSync(file, 'w');
  let batch: string[] = [];
  const flush = () => {
    if (batch.length) fs.writeSync(fd, `${batch.join('\n')}\n`);
    batch = [];
  };
  for (const record of transcriptRecords(options)) {
    batch.push(JSON.stringify(record));
    if (batch.length >= 2000) flush();
  }
  flush();
  fs.closeSync(fd);
  const before = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = dir;
  return {
    file,
    dir,
    size: fs.statSync(file).size,
    done: () => {
      if (before === undefined) delete process.env.CLAUDE_CONFIG_DIR;
      else process.env.CLAUDE_CONFIG_DIR = before;
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}
