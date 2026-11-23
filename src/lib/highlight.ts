// Syntax highlighting for code blocks and diffs. Code blocks highlight in a dedicated worker, so Shiki's grammar
// loads and tokenizing never block the frames of a streaming reply (Claude Desktop does the same, in its
// `highlightWorker`); where there is no worker, or it fails, the engine runs in the window as before.

import type { Highlighted } from './highlightEngine';
import { cacheable } from './highlightCache';

/** What the window and the worker say to each other: one request per id, answered by html or by an error. */
export type HighlightRequest = { id: number; code: string; lang: string; dark: boolean };
export type HighlightReply = { id: number; html: string; final: boolean } | { id: number; error: string };

type Pending = { resolve: (html: Highlighted) => void; reject: (error: Error) => void };

/** The worker is gone (it failed to start or crashed): callers highlight in the window instead. */
class WorkerGone extends Error {}

/** One worker for the window, started on first use. A crashed worker is not started again: the window takes over. */
/** How long the worker may take to answer before the window takes over (a stuck grammar load must not leave code plain). */
export const WORKER_TIMEOUT_MS = 8000;

export function createHighlightClient(make: () => Worker, timeoutMs = WORKER_TIMEOUT_MS) {
  let worker: Worker | null = null;
  let broken = false;
  let next = 0;
  const pending = new Map<number, Pending>();
  const lose = (why: string) => {
    broken = true;
    worker?.terminate();
    worker = null;
    for (const p of pending.values()) p.reject(new WorkerGone(why));
    pending.clear();
  };
  const start = () => {
    const w = make();
    w.onmessage = ({ data }: MessageEvent<HighlightReply>) => {
      const p = pending.get(data.id);
      pending.delete(data.id);
      if ('error' in data) p?.reject(new Error(data.error));
      else p?.resolve({ html: data.html, final: data.final });
    };
    w.onerror = () => lose('highlight worker failed');
    w.onmessageerror = () => lose('highlight worker sent an unreadable reply');
    return w;
  };
  return {
    /** The html with whether it is final, or null when the worker cannot be used (the caller highlights in the window). */
    async run(code: string, lang: string, dark: boolean): Promise<Highlighted | null> {
      if (broken) return null;
      const id = next++;
      let reply: Promise<Highlighted>;
      try {
        worker ??= start();
        reply = new Promise<Highlighted>((resolve, reject) => pending.set(id, { resolve, reject }));
        worker.postMessage({ id, code, lang, dark } satisfies HighlightRequest);
      } catch {
        // not awaited yet: forget it first, so losing the worker does not reject a promise nobody reads
        pending.delete(id);
        lose('highlight worker unavailable');
        return null;
      }
      const watchdog = setTimeout(() => lose('highlight worker timed out'), timeoutMs);
      const settled = () => clearTimeout(watchdog);
      reply.then(settled, settled);
      try {
        return await reply;
      } catch (error) {
        if (error instanceof WorkerGone) return null;
        throw error;
      }
    },
  };
}

const client = createHighlightClient(
  () => new Worker(new URL('./highlightWorker.ts', import.meta.url), { type: 'module', name: 'shiki-highlight' }),
);
const engine = () => import('./highlightEngine');

/** Results the window has, so a block that mounts again shows highlighted at once instead of after a worker round trip. */
const results = new Map<string, string>();
const RESULTS_LIMIT = 400;

/** Code block html. The worker does the work when there is one; the engine in the window is the fallback. */
export async function highlight(code: string, lang: string, dark: boolean): Promise<string> {
  const key = JSON.stringify([dark, lang, code]);
  const hit = results.get(key);
  if (hit !== undefined) return hit;
  let done: Highlighted | null = null;
  if (typeof Worker !== 'undefined') done = await client.run(code, lang, dark);
  done ??= await (await engine()).highlightEntry(code, lang, dark);
  if (done.final && cacheable(code)) {
    if (results.size >= RESULTS_LIMIT) results.clear();
    results.set(key, done.html);
  }
  return done.html;
}

/** Tokenize lines for diff rendering; returns per-line arrays of [text, color]. */
export async function tokenizeLines(code: string, lang: string, dark: boolean) {
  return (await engine()).tokenizeLines(code, lang, dark);
}

export function langFromPath(p: string) {
  const ext = p.slice(p.lastIndexOf('.') + 1).toLowerCase();
  const map: Record<string, string> = {
    ts: 'typescript',
    tsx: 'tsx',
    js: 'javascript',
    jsx: 'jsx',
    mjs: 'javascript',
    cjs: 'javascript',
    py: 'python',
    rs: 'rust',
    go: 'go',
    rb: 'ruby',
    java: 'java',
    kt: 'kotlin',
    swift: 'swift',
    c: 'c',
    h: 'c',
    cc: 'cpp',
    cpp: 'cpp',
    hpp: 'cpp',
    cs: 'csharp',
    m: 'objective-c',
    json: 'json',
    yaml: 'yaml',
    yml: 'yaml',
    toml: 'toml',
    md: 'markdown',
    markdown: 'markdown',
    mdown: 'markdown',
    mdx: 'mdx',
    html: 'html',
    css: 'css',
    scss: 'scss',
    sql: 'sql',
    sh: 'bash',
    zsh: 'bash',
    bash: 'bash',
    vue: 'vue',
    svelte: 'svelte',
    php: 'php',
    lua: 'lua',
    dart: 'dart',
    ex: 'elixir',
    exs: 'elixir',
    dockerfile: 'dockerfile',
    xml: 'xml',
    graphql: 'graphql',
    proto: 'proto',
    tf: 'hcl',
  };
  if (p.toLowerCase().endsWith('dockerfile')) return 'dockerfile';
  return Object.hasOwn(map, ext) ? map[ext] : 'text';
}
