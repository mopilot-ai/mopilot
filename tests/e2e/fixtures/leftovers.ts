// Windows only: reports and ends the processes a launch left running after its app closed.

// What the app had started, and anything whose command line names the launch's folder, is told in the log and then
// ended, so one test's leftovers neither hold the next one's files nor pile up on the runner. macOS and Linux end a
// launch's process group with it; Windows ends no child with its parent.
import { execFileSync } from 'node:child_process';

interface Proc {
  ProcessId: number;
  ParentProcessId: number;
  Name: string;
  CommandLine: string | null;
  CreationDate: string;
}

/** Every process on the machine, as Windows lists them; [] when the list can't be read (told in the log). */
function processes(): Proc[] {
  const script =
    '@(Get-CimInstance Win32_Process | Select-Object ProcessId, ParentProcessId, Name, CommandLine, @{n="CreationDate";e={[string]$_.CreationDate.ToFileTimeUtc()}}) | ConvertTo-Json -Compress -Depth 2';
  try {
    const out = execFileSync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], {
      encoding: 'utf8',
      timeout: 30_000,
      windowsHide: true,
      maxBuffer: 64 * 1024 * 1024,
    }).trim();
    const parsed = out ? JSON.parse(out) : [];
    return (Array.isArray(parsed) ? parsed : [parsed]).map((p: Proc) => ({
      ...p,
      CreationDate: /^\d+$/.test(String(p.CreationDate)) ? String(p.CreationDate) : '0',
    }));
  } catch (error) {
    console.warn(`[e2e leftovers] could not list the processes: ${(error as Error).message}`);
    return [];
  }
}

const key = (p: Proc) => `${p.ProcessId}@${p.CreationDate}`;

/** What `root` (the app's pid) has started, at any depth; [] off Windows. Read while the app still runs. */
export function startedBy(root: number | undefined): Proc[] {
  if (process.platform !== 'win32' || !root) return [];
  const all = processes();
  const top = all.find((p) => p.ProcessId === root);
  if (!top) return [];
  const found: Proc[] = [];
  // a parent's pid by when it started: Windows reuses pids, and a process keeps the pid of a parent long gone (a
  // linker's telemetry helper), so a child counts only when it started after the process holding that pid now
  const parents = new Map([[root, BigInt(top.CreationDate)]]);
  for (let grew = true; grew; ) {
    grew = false;
    for (const p of all) {
      const parentStart = parents.get(p.ParentProcessId);
      if (parentStart === undefined || parents.has(p.ProcessId) || BigInt(p.CreationDate) < parentStart) continue;
      parents.set(p.ProcessId, BigInt(p.CreationDate));
      found.push(p);
      grew = true;
    }
  }
  return found;
}

/**
 * After the app closed: waits up to `graceMs` for what it started (`before`, from startedBy) and whatever names `dir` to
 * end, then reports and ends what is left.
 */
export async function endLeftovers(before: Proc[], dir: string, test: string, graceMs = 3000): Promise<void> {
  if (process.platform !== 'win32') return;
  const known = new Set(before.map(key));
  const left = () => processes().filter((p) => p.ProcessId !== process.pid && (known.has(key(p)) || (p.CommandLine ?? '').includes(dir)));
  const until = Date.now() + graceMs;
  let still = left();
  while (still.length && Date.now() < until) {
    await new Promise((r) => setTimeout(r, 500));
    still = left();
  }
  if (!still.length) return;
  console.warn(
    `[e2e leftovers] ${test}: ${still.length} process(es) still running after the app closed:\n${still
      .map((p) => `  ${p.ProcessId} (parent ${p.ParentProcessId}) ${p.Name}: ${(p.CommandLine ?? '').slice(0, 300)}`)
      .join('\n')}`,
  );
  // each one checked above, alone: a tree walk of Windows' own (taskkill /T) would follow a pid another process reuses
  for (const p of still) {
    try {
      process.kill(p.ProcessId);
    } catch {
      // it ended meanwhile
    }
  }
}
