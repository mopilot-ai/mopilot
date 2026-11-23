// What a turn spent waiting, on every harness: a Codex sleep item, a `sleep N && …` or wait-loop command, a sleep tool.
import { prettyCommand } from './format';

const UNIT_MS: Record<string, number> = { '': 1000, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 };

/** `sleep 50`, `sleep 1.5m`: the shell's own units (seconds by default). */
const SLEEP_RE = /^sleep\s+(\d+(?:\.\d+)?)([smhd]?)(?=\s|$|;|&)/;

/**
 * The wait a command starts with: `sleep 50 && gh api …` waits 50s and then runs `gh api …` (`rest`); a bare `sleep 50`
 * is all wait (`rest` empty). Null for any other command, and for a sleep joined by `||` or a pipe (not a wait first).
 */
export function sleepPrefix(command: string): { ms: number; rest: string } | null {
  const cmd = command.trim();
  const m = SLEEP_RE.exec(cmd);
  if (!m) return null;
  const ms = Math.round(Number(m[1]) * UNIT_MS[m[2]]);
  const after = cmd.slice(m[0].length).trimStart();
  if (!after) return { ms, rest: '' };
  const join = /^(&&|;)\s*/.exec(after);
  return join ? { ms, rest: after.slice(join[0].length).trim() } : null;
}

/** A loop that polls: `until gh run view …; do sleep 30; done`, `while …; do …; sleep 10; done`. */
export function isWaitLoop(command: string): boolean {
  return /\b(while|until)\b[\s\S]*\bdo\b[\s\S]*\bsleep\s+\d[\s\S]*\bdone\b/.test(command);
}

/** A command's wait: its leading sleep (`rest` is what runs after it), or a wait loop timed by how long it ran. */
export type CommandWait = { ms: number | null; rest: string; loop: boolean };

export function commandWait(item: { command: string; durationMs?: number | null }): CommandWait | null {
  const cmd = prettyCommand(item.command).trim();
  const lead = sleepPrefix(cmd);
  if (lead && !isWaitLoop(lead.rest)) return { ms: lead.ms, rest: lead.rest, loop: false };
  if (isWaitLoop(cmd)) return { ms: item.durationMs ?? null, rest: cmd, loop: true };
  return null;
}

/** The argument names a sleep tool's duration goes by, and what one unit of each is in ms. */
const DURATION_ARGS: [string, number][] = [
  ['ms', 1],
  ['milliseconds', 1],
  ['duration_ms', 1],
  ['durationMs', 1],
  ['seconds', 1000],
  ['secs', 1000],
  ['duration', 1000],
  ['duration_seconds', 1000],
  ['time', 1000],
];

/**
 * A tool call that only waits (an ACP agent's `sleep` or `wait` tool, which translates with no server): how long it
 * asked for, or null when it gave no duration. Undefined for any other tool, and for another server's tool of that name.
 */
export function toolWaitMs(item: { tool?: unknown; server?: unknown; arguments?: unknown }): number | null | undefined {
  if (typeof item.tool !== 'string' || !/^(sleep|wait)$/i.test(item.tool.trim())) return undefined;
  if (typeof item.server === 'string' && item.server !== '') return undefined;
  const args = (item.arguments && typeof item.arguments === 'object' ? item.arguments : {}) as Record<string, unknown>;
  for (const [name, unit] of DURATION_ARGS) {
    const v = Number(args[name]);
    if (args[name] != null && args[name] !== '' && Number.isFinite(v) && v >= 0) return Math.round(v * unit);
  }
  return null;
}

/**
 * A tool call that waits: a sleep tool (toolWaitMs), or a read that blocks until a background task settles (Claude
 * Code's TaskOutput, `block` defaulting to true), timed by how long the call took. `on` is what it waited for.
 */
export function toolWait(item: {
  tool?: unknown;
  server?: unknown;
  arguments?: unknown;
  durationMs?: number | null;
}): { ms: number | null; on?: string } | null {
  const ms = toolWaitMs(item);
  if (ms !== undefined) return { ms };
  const args = (item.arguments && typeof item.arguments === 'object' ? item.arguments : {}) as Record<string, unknown>;
  if (item.tool === 'TaskOutput' && !item.server && args.block !== false) return { ms: item.durationMs ?? null, on: 'a background task' };
  return null;
}

/** A call that arms a watch to wake the agent later: a monitor on a command's output, or a scheduled check-in. */
export type WatchCall = { what: 'monitor' | 'checkin'; label: string | null; ms: number | null; stop: boolean };

/**
 * Claude Code's Monitor (`description`, `timeout_ms`) and ScheduleWakeup (`delaySeconds`, `stop`), as an ACP adapter
 * passes them too (no server); null for any other tool.
 */
export function watchCall(item: { tool?: unknown; server?: unknown; arguments?: unknown }): WatchCall | null {
  if (item.server) return null;
  const args = (item.arguments && typeof item.arguments === 'object' ? item.arguments : {}) as Record<string, unknown>;
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null);
  if (item.tool === 'Monitor') {
    const label = typeof args.description === 'string' && args.description.trim() ? args.description.trim() : null;
    return { what: 'monitor', label, ms: num(args.timeout_ms), stop: false };
  }
  if (item.tool === 'ScheduleWakeup') {
    const seconds = num(args.delaySeconds);
    return { what: 'checkin', label: null, ms: seconds == null ? null : seconds * 1000, stop: args.stop === true };
  }
  return null;
}
