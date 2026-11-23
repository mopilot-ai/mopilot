// Pacing for the streaming benchmark's fake harnesses: the reply each turn streams, cut into deltas sent at a token rate, and the run's control folder (replay settings, the start gate, turn events).
import fs from 'node:fs';
import path from 'node:path';

/** Characters per token, to turn a token rate into a character rate (the usual estimate for English text). */
export const CHARS_PER_TOKEN = 4;
/** How a message the runner types starts: only those turns are replayed (rewrite.mjs). */
export const MARK = '[bench]';
/** How often a held turn checks whether the runner opened the gate. */
export const GATE_POLL_MS = 20;

/**
 * @typedef {{ mode: 'pass' } | { mode: 'replay', bytes: number, rate: number, chunk: number, toolEveryMs?: number, gate?: boolean, text?: string }} Settings
 *   pass: the fake answers as it does in the e2e tests; replay: each reply is `text` (or a synthetic one of `bytes`
 *   characters) in deltas of `chunk` characters at `rate` tokens per second, with an ACP tool call every `toolEveryMs`,
 *   waiting for the gate when `gate` is set
 */

const WORDS =
  'stream render frame token delta batch window thread commit store layout paint queue flush writer reply message chat agent model'.split(
    ' ',
  );

/**
 * A Markdown reply of exactly `bytes` characters, the same for the same size: paragraphs, a list and a code block, so
 * the renderer parses what a real reply holds.
 * @param {number} bytes
 */
export function makeReply(bytes) {
  const blocks = [];
  let n = 0;
  const word = () => WORDS[n++ % WORDS.length];
  const sentence = (len) => `${Array.from({ length: len }, word).join(' ')}.`;
  for (let i = 0; blocks.join('\n\n').length < bytes; i++) {
    if (i % 4 === 1) blocks.push(Array.from({ length: 3 }, () => `- ${sentence(6)}`).join('\n'));
    else if (i % 4 === 3) blocks.push(`\`\`\`js\nconst ${word()} = ${i};\nconsole.log(${i} * 2);\n\`\`\``);
    else blocks.push(Array.from({ length: 4 }, () => sentence(9)).join(' '));
  }
  return blocks.join('\n\n').slice(0, bytes);
}

/** `text` cut into pieces of `size` characters (code points, so no piece splits a character). */
export function chunksOf(/** @type {string} */ text, /** @type {number} */ size) {
  const chars = Array.from(text);
  const out = [];
  for (let i = 0; i < chars.length; i += size) out.push(chars.slice(i, i + size).join(''));
  return out;
}

/** Milliseconds between two deltas of `chunk` characters at `rate` tokens per second. */
export const intervalMs = (/** @type {number} */ rate, /** @type {number} */ chunk) => (chunk / (rate * CHARS_PER_TOKEN)) * 1000;

/**
 * The settings in the control folder's replay.json; pass-through when there is no folder or file.
 * @param {string | undefined} dir
 * @param {{ read?: (file: string) => string }} [deps]
 * @returns {Settings}
 */
export function readSettings(dir, { read = (f) => fs.readFileSync(f, 'utf8') } = {}) {
  if (!dir) return { mode: 'pass' };
  let raw;
  try {
    raw = JSON.parse(read(path.join(dir, 'replay.json')));
  } catch {
    // no settings written yet: answer as the e2e fake does
    return { mode: 'pass' };
  }
  if (raw?.mode !== 'replay') return { mode: 'pass' };
  return {
    mode: 'replay',
    bytes: Math.max(1, Number(raw.bytes) || 4096),
    rate: Math.max(1, Number(raw.rate) || 40),
    chunk: Math.max(1, Number(raw.chunk) || 4),
    toolEveryMs: Math.max(0, Number(raw.toolEveryMs) || 0),
    gate: raw.gate === true,
    ...(typeof raw.text === 'string' ? { text: raw.text } : {}),
  };
}

/**
 * Appends one turn event ({ kind: 'start' | 'end', ... }) to the control folder's events.jsonl, for the runner.
 * @param {string | undefined} dir
 * @param {Record<string, unknown>} event
 * @param {{ append?: (file: string, text: string) => void, now?: () => number }} [deps]
 */
export function logEvent(dir, event, { append = fs.appendFileSync, now = Date.now } = {}) {
  if (!dir) return;
  append(path.join(dir, 'events.jsonl'), `${JSON.stringify({ at: now(), pid: process.pid, ...event })}\n`);
}

/**
 * Resolves once the runner opens the gate (the control folder's `go` file), at once when there is no gate.
 * @param {string | undefined} dir
 * @param {{ exists?: (file: string) => boolean, setTimeout?: typeof setTimeout }} [deps]
 */
export function waitGate(dir, { exists = fs.existsSync, setTimeout: later = setTimeout } = {}) {
  if (!dir) return Promise.resolve();
  const go = path.join(dir, 'go');
  return new Promise((resolve) => {
    const check = () => (exists(go) ? resolve(undefined) : later(check, GATE_POLL_MS));
    check();
  });
}

/**
 * Plays a reply: each delta at its time from the start (so a slow tick does not stretch the run), and a tool call
 * every `toolEveryMs` while it plays. `cancel` ends it before the next delta.
 * @param {{ text: string, rate: number, chunk: number, toolEveryMs?: number }} s
 * @param {{ onChunk: (text: string) => void, onTool?: (n: number) => void }} on
 * @param {{ now?: () => number, setTimeout?: typeof setTimeout, clearTimeout?: typeof clearTimeout, gate?: () => Promise<unknown> }} [deps]
 * @returns {{ done: Promise<void>, cancel: () => void }}
 */
export function play(
  s,
  on,
  { now = Date.now, setTimeout: later = setTimeout, clearTimeout: stopLater = clearTimeout, gate = () => Promise.resolve() } = {},
) {
  const chunks = chunksOf(s.text, s.chunk);
  const step = intervalMs(s.rate, s.chunk);
  const toolEvery = s.toolEveryMs ?? 0;
  let cancelled = false;
  /** @type {{ timer: unknown, wake: () => void } | null} */
  let sleeping = null;
  const sleepUntil = (/** @type {number} */ at) =>
    new Promise((resolve) => {
      const wake = () => {
        sleeping = null;
        resolve(undefined);
      };
      sleeping = { timer: later(wake, Math.max(0, at - now())), wake };
    });
  const done = (async () => {
    await gate();
    const start = now();
    let tools = 1;
    for (let i = 0; i < chunks.length && !cancelled; ) {
      const chunkAt = start + i * step;
      const toolAt = toolEvery > 0 ? start + tools * toolEvery : Number.POSITIVE_INFINITY;
      await sleepUntil(Math.min(chunkAt, toolAt));
      if (cancelled) break;
      if (toolAt <= chunkAt) on.onTool?.(tools++);
      else on.onChunk(chunks[i++]);
    }
  })();
  return {
    done,
    cancel() {
      cancelled = true;
      if (sleeping) {
        stopLater(/** @type {any} */ (sleeping.timer));
        sleeping.wake();
      }
    },
  };
}
