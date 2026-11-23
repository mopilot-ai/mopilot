// Claude Code process-lifetime benchmark (#1830): N chats run a real multi-step task at once in a MoPilot dev instance
// driven over CDP; it samples the instance's process tree (phys_footprint) and times a follow-up's first output on a warm
// chat (CLI alive), a cold one (CLI ended, no view) and one warmed on open (CLI ended, chat opened first). macOS only.
//
//   node bench/lifetime/run.mjs --cdp 9571 --cwd <scratch project> [--chats 6] [--idle-min 3] [--claude-bin <path>]
//                               [--model haiku] [--out bench-lifetime.json]
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';

const { values: a } = parseArgs({
  options: {
    cdp: { type: 'string', default: '9571' },
    cwd: { type: 'string' },
    chats: { type: 'string', default: '6' },
    'idle-min': { type: 'string', default: '3' },
    'claude-bin': { type: 'string' },
    model: { type: 'string', default: 'haiku' },
    out: { type: 'string', default: 'bench-lifetime.json' },
  },
});
if (!a.cwd) throw new Error('--cwd <scratch project folder> is required (node scripts/test-chats.mjs folder --run <tag>)');
const N = Number(a.chats);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/* -- CDP ------------------------------------------------------------------------------------- */
async function connectPage() {
  const list = await (await fetch(`http://127.0.0.1:${a.cdp}/json`)).json();
  const t = list.find((x) => x.type === 'page' && !x.url.includes('#mini') && /^(http|file)/.test(x.url));
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  await new Promise((r, j) => ((ws.onopen = r), (ws.onerror = j)));
  let id = 0;
  const pending = new Map();
  ws.onmessage = (m) => {
    const d = JSON.parse(m.data);
    if (d.id && pending.has(d.id)) pending.get(d.id)(d), pending.delete(d.id);
  };
  const send = (method, params = {}) => new Promise((r) => (pending.set(++id, r), ws.send(JSON.stringify({ id, method, params }))));
  const evaluate = async (expression) => {
    const d = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (d.result?.exceptionDetails) throw new Error(JSON.stringify(d.result.exceptionDetails).slice(0, 400));
    return d.result?.result?.value;
  };
  return { evaluate, close: () => ws.close() };
}

/* -- process tree ---------------------------------------------------------------------------- */
function footprintMb(pid) {
  try {
    const m = execFileSync('footprint', ['-p', String(pid)], { stdio: ['ignore', 'pipe', 'ignore'] })
      .toString()
      .match(/phys_footprint:\s+([\d.]+)\s*(\w+)/);
    if (!m) return 0;
    const v = Number(m[1]);
    return m[2].startsWith('G') ? v * 1024 : m[2].startsWith('K') ? v / 1024 : v;
  } catch {
    return 0;
  }
}
function tree() {
  const rows = execFileSync('ps', ['-axo', 'pid=,ppid=,args='])
    .toString()
    .trim()
    .split('\n')
    .map((l) => {
      const [pid, ppid, ...rest] = l.trim().split(/\s+/);
      return { pid: Number(pid), ppid: Number(ppid), args: rest.join(' ') };
    });
  const root = rows.find((r) => r.args.includes(`--remote-debugging-port=${a.cdp}`) && !r.args.includes('--type='));
  const all = [];
  const walk = (p) => (all.push(p), rows.filter((r) => r.ppid === p.pid).forEach(walk));
  if (root) walk(root);
  const clis = all.filter((p) => /stream-json/.test(p.args) && /claude/.test(p.args));
  const under = new Set();
  const mark = (pid) => (under.add(pid), all.filter((c) => c.ppid === pid).forEach((c) => mark(c.pid)));
  clis.forEach((c) => mark(c.pid));
  let total = 0;
  let cliTree = 0;
  for (const p of all) {
    const f = footprintMb(p.pid);
    total += f;
    if (under.has(p.pid)) cliTree += f;
  }
  return { clis: clis.length, cliTreeMb: Math.round(cliTree), totalMb: Math.round(total) };
}

/* -- the run --------------------------------------------------------------------------------- */
const p = await connectPage();
const t0 = Date.now();
/** @type {{ args: any, samples: any[], turns: { label: string, firstMs: number | null, doneMs: number | null, status: string }[], summary?: any }} */
const out = { args: a, samples: [], turns: [] };
const sample = (label) => {
  const s = { t: Math.round((Date.now() - t0) / 1000), label, ...tree() };
  out.samples.push(s);
  console.log(`${String(s.t).padStart(5)}s ${label.padEnd(16)} clis=${s.clis} cliTree=${s.cliTreeMb}MB total=${s.totalMb}MB`);
};
const state = (id) =>
  p
    .evaluate(
      `(async()=>{const c=await import('/src/store/core.ts');const r=c.useStore.getState().runtime[${JSON.stringify(id)}];const t=r?.turns?.at(-1);return JSON.stringify({n:r?.turns?.length??0,status:t?.status??null,items:(t?.items??[]).filter(i=>i.type!=='userMessage').length})})()`,
    )
    .then(JSON.parse);
async function timed(id, text, label) {
  const before = (await state(id)).n;
  const start = Date.now();
  /** @type {number | null} */
  let first = null;
  await p.evaluate(`import('/src/store/send.ts').then(m=>m.sendMessage(${JSON.stringify(id)}, ${JSON.stringify(text)}))`);
  for (let i = 0; i < 1200; i++) {
    await wait(200);
    const st = await state(id);
    if (st.n > before && st.items > 0 && first == null) first = Date.now() - start;
    if (st.n > before && ['completed', 'failed', 'interrupted'].includes(st.status)) {
      const r = { label, firstMs: first, doneMs: Date.now() - start, status: st.status };
      out.turns.push(r);
      console.log(`  ${label.padEnd(22)} first output ${first}ms, done ${r.doneMs}ms (${st.status})`);
      return r;
    }
  }
  out.turns.push({ label, firstMs: first, doneMs: null, status: 'timeout' });
}
const navigate = (route) => p.evaluate(`import('/src/store/panes.ts').then(m=>m.navigate(${JSON.stringify(route)}))`);
const closeCli = (id) => p.evaluate(`window.native.claude.control(${JSON.stringify(id)}, 'close')`);

if (a['claude-bin']) await p.evaluate(`import('/src/store/core.ts').then(c=>c.setPrefs({claudeBin:${JSON.stringify(a['claude-bin'])}}))`);
await navigate({ name: 'home' });
await wait(2000);
sample('before');
const task = (i) =>
  `[test] lifetime chat ${i}: in this folder create stats_${i}.py with mean() and median(), write test_stats_${i}.py with three assert-based tests, run it with python3, fix any failure, and reply with the pass count.`;
const follow = (i, what) => `[test] lifetime ${what} ${i}: run test_stats_${i}.py with python3 and reply with the pass count only.`;
const ids = [];
for (let i = 0; i < N; i++)
  ids.push(
    await p.evaluate(
      `(async()=>{const send=await import('/src/store/send.ts');const sel=await import('/src/harness/select.ts');const id=await send.startNewChat('claude',{cwd:${JSON.stringify(a.cwd)},proj:null,ephemeral:undefined,basic:undefined});sel.setSelection('claude',{model:${JSON.stringify(a.model)}},id);return id})()`,
    ),
  );
await navigate({ name: 'home' });
await Promise.all(ids.map((id, i) => timed(id, task(i), `first turn c${i}`)));
sample('all done');
const idleUntil = Date.now() + Number(a['idle-min']) * 60_000;
while (Date.now() < idleUntil) {
  await wait(30_000);
  sample(`idle +${((Date.now() - (idleUntil - Number(a['idle-min']) * 60_000)) / 60_000).toFixed(1)}m`);
}
for (let k = 0; k < Math.min(3, N); k++) await timed(ids[k], follow(k, 'warm'), `warm c${k}`);
// cold: the CLI ended and the chat was not opened before the send
for (let k = 0; k < Math.min(3, N); k++) {
  await closeCli(ids[k]);
  await wait(3000);
  await timed(ids[k], follow(k, 'cold'), `cold c${k}`);
}
// warmed on open: the CLI ended, the chat opened a moment before the send
for (let k = 0; k < Math.min(3, N); k++) {
  await closeCli(ids[k]);
  await wait(3000);
  await navigate({ name: 'thread', id: ids[k] });
  await wait(6000);
  await timed(ids[k], follow(k, 'opened'), `warmed on open c${k}`);
  await navigate({ name: 'home' });
}
sample('end');
const med = (label) => {
  const v = out.turns
    .filter((t) => t.label.startsWith(label))
    .flatMap((t) => (t.firstMs == null ? [] : [t.firstMs]))
    .sort((x, y) => x - y);
  return v.length ? v[Math.floor(v.length / 2)] : null;
};
out.summary = { warmFirstMs: med('warm c'), coldFirstMs: med('cold c'), openedFirstMs: med('warmed on open'), chats: ids };
console.log('summary', JSON.stringify(out.summary));
writeFileSync(a.out, JSON.stringify(out, null, 1));
p.close();
