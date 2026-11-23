// A passive sample of Claude Desktop's Claude Code CLIs on this Mac (#1830): each CLI's footprint, its process tree's (its
// MCP servers), its age and CPU. It only reads ps and footprint; it never drives Claude Desktop. macOS only.
//
//   node bench/lifetime/cd-sample.mjs [--out cd-sample.json]
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';

const { values: a } = parseArgs({ options: { out: { type: 'string', default: 'cd-sample.json' } } });

const seconds = (etime) => {
  const [d, hms] = etime.includes('-') ? etime.split('-') : ['0', etime];
  const parts = hms.split(':').map(Number);
  while (parts.length < 3) parts.unshift(0);
  return Number(d) * 86400 + parts[0] * 3600 + parts[1] * 60 + parts[2];
};
const footprintMb = (pid) => {
  try {
    const m = execFileSync('footprint', ['-p', String(pid)], { stdio: ['ignore', 'pipe', 'ignore'] })
      .toString()
      .match(/phys_footprint:\s+([\d.]+)\s*(\w+)/);
    const v = m ? Number(m[1]) : 0;
    return !m ? 0 : m[2].startsWith('G') ? v * 1024 : m[2].startsWith('K') ? v / 1024 : v;
  } catch {
    return 0;
  }
};
const rows = execFileSync('ps', ['-axo', 'pid=,ppid=,etime=,pcpu=,args='])
  .toString()
  .trim()
  .split('\n')
  .map((l) => {
    const [pid, ppid, etime, pcpu, ...rest] = l.trim().split(/\s+/);
    return { pid: Number(pid), ppid: Number(ppid), age: seconds(etime), cpu: Number(pcpu), args: rest.join(' ') };
  });
const kids = (pid) => rows.filter((r) => r.ppid === pid);
const subtree = (pid) => [pid, ...kids(pid).flatMap((k) => subtree(k.pid))];
// the CLI itself, not the Helpers/disclaimer wrapper Claude Desktop starts it through
const clis = rows.filter(
  (r) =>
    /claude\.app\/Contents\/MacOS\/claude /.test(r.args) && r.args.includes('--input-format stream-json') && !r.args.includes('disclaimer'),
);
const out = clis.map((c) => ({
  pid: c.pid,
  ageH: +(c.age / 3600).toFixed(2),
  cpu: c.cpu,
  cliMb: Math.round(footprintMb(c.pid)),
  treeMb: Math.round(subtree(c.pid).reduce((s, p) => s + footprintMb(p), 0)),
}));
out.sort((x, y) => y.ageH - x.ageH);
for (const r of out) console.log(r);
const summary = {
  clis: out.length,
  idle: out.filter((r) => r.cpu < 1).length,
  treeTotalMb: out.reduce((s, r) => s + r.treeMb, 0),
  meanTreeMb: out.length ? Math.round(out.reduce((s, r) => s + r.treeMb, 0) / out.length) : 0,
  ageRangeH: out.length ? [out[out.length - 1].ageH, out[0].ageH] : null,
};
console.log('summary', JSON.stringify(summary));
writeFileSync(a.out, JSON.stringify({ at: new Date().toISOString(), summary, clis: out }, null, 1));
