// A task run's screen recording in the benchmark VM (#1381, #1511): `screencapture -v` in 20 s parts, each part's start
// time in a manifest, so motion and dead air can be scored later from the recording and the transcript.
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const UID = process.env.BENCH_GUI_UID ?? '501';
/** A part's length: a recording stops only at the end of a part (a signal loses the part), so this is the wait at stop. */
const PART_S = 20;

/**
 * Starts recording the screen to `<base>.rec-<n>.mov`, one part after another, until the returned stop is called.
 * `screencapture -v` writes its file only when it ends by itself (a signal or a key loses it), so it records in parts
 * of PART_S seconds; each part's start (epoch ms) goes to `<base>.rec.txt`. Never throws: a recorder that cannot start
 * leaves no parts, and stop says so.
 * @param {string} base the result's path without extension
 * @returns {{ stop: () => Promise<{ parts: { file: string, startedAt: number }[], startedAt: number, endedAt: number }> }}
 */
export function startRecording(base) {
  const stopFile = `${base}.rec.stop`;
  const manifest = `${base}.rec.txt`;
  writeFileSync(manifest, '');
  const script = `n=0; while [ ! -e ${JSON.stringify(stopFile)} ]; do
  t=$(perl -MTime::HiRes=time -e 'printf "%d", time*1000'); echo "$n $t" >> ${JSON.stringify(manifest)}
  /usr/sbin/screencapture -v -x -C -k -V ${PART_S} ${JSON.stringify(`${base}.rec-`)}$n.mov >/dev/null 2>&1 || break; n=$((n+1)); done`;
  const startedAt = Date.now();
  /** @type {import('node:child_process').ChildProcess | null} */
  let child = null;
  try {
    child = spawn('launchctl', ['asuser', UID, 'bash', '-c', script], { stdio: 'ignore' });
    child.on('error', () => {
      // no recorder: stop finds no parts
    });
  } catch {
    child = null;
  }
  return {
    async stop() {
      writeFileSync(stopFile, '');
      // the part under way ends by itself within PART_S; a recorder still running after that is stopped
      if (child && child.exitCode === null)
        await new Promise((resolve) => {
          const timer = setTimeout(
            () => {
              child?.kill('SIGKILL');
              resolve(null);
            },
            (PART_S + 10) * 1000,
          );
          child?.on('exit', () => {
            clearTimeout(timer);
            resolve(null);
          });
        });
      const endedAt = Date.now();
      const parts = readFileSync(manifest, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((l) => l.split(' '))
        .map(([n, t]) => ({ file: `${path.basename(base)}.rec-${n}.mov`, startedAt: Number(t) }))
        .filter((p) => existsSync(path.join(path.dirname(base), p.file)));
      rmSync(stopFile, { force: true });
      return { parts, startedAt, endedAt };
    },
  };
}
