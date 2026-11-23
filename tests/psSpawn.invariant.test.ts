// Invariant: main, the Host and the code they share start no `ps`. The process table, parents, command lines and start
// times come from the Rust core (core/crates/proc, core/crates/caps), which has no JS copy to drift from; a failing or missing
// ps once meant a different thing at each caller. One line of relayPeers.cjs stays, on a path kept on purpose.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const repo = path.resolve(import.meta.dirname, '..');
const FOLDERS = ['electron', 'shared', 'host/src', 'host/bin'];
/** The one `ps` left: relayPeers.cjs asks for a process's parent and name. */
const KEPT = [
  "electron/identity/accounts/relayPeers.cjs: const m = /^\\s*(\\d+)\\s+(.+?)\\s*$/.exec(await run('/bin/ps', ['-o', 'ppid=,comm=', '-p', String(pid)], exec));",
];

function walk(dir: string, out: string[] = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const f = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name !== 'node_modules') walk(f, out);
    } else if (/\.(cjs|mjs|js|ts|tsx)$/.test(e.name)) out.push(f);
  }
  return out;
}

/** A source with its comments blanked, which may quote what was measured with ps. Lines stay where they are. */
const codeOf = (text: string) => text.replace(/^\s*(?:\/\/|\/?\*).*$/gm, '').replace(/\s\/\/\s.*$/gm, '');

/** Each string literal or template in a source. */
const LITERAL = /'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"|`(?:[^`\\]|\\.)*`/g;

/** Where a shell word is a command: a literal's start, after a separator or `$(`, or after a command that runs another. */
const COMMAND_START = String.raw`(?:^|[;&|(]\s*|\b(?:sudo|env|exec|command|nohup|time|xargs)\s+(?:-\S+\s+)*)`;
/** What follows ps as a command: nothing, a separator, a dashed option, or the bare letters of `ps aux`. */
const PS_ARGS = String.raw`(?=\s*$|\s*[;&|)]|\s+-\S|\s+[aAefjlmoSTuvwx]+(?:\s|$))`;
const PS_WORD = new RegExp(String.raw`${COMMAND_START}(?:\S*/)?ps${PS_ARGS}`);
/** An absolute ps wherever it stands in a literal. */
const PS_PATH = /(?:^|[\s=:(])(?:\/[\w.-]+)*\/s?bin\/ps(?=$|[\s;&|)])/;

/** The source lines of `text` with a literal that runs ps, trimmed. */
function linesRunningPs(text: string) {
  const code = codeOf(text);
  const lines = code.split('\n');
  const found = new Set<number>();
  for (const m of code.matchAll(LITERAL)) {
    // an escaped tab or line break separates words as a real one does
    const inner = m[0].slice(1, -1).replace(/\\[tnr]/g, ' ');
    if (PS_WORD.test(inner) || PS_PATH.test(inner)) found.add(code.slice(0, m.index).split('\n').length - 1);
  }
  return [...found].map((i) => lines[i].trim());
}

/** Each line under `dirs` that runs ps, as `file: line`. */
function runningPs(dirs: string[]) {
  return dirs
    .flatMap((d) => walk(path.join(repo, d)))
    .flatMap((f) =>
      linesRunningPs(fs.readFileSync(f, 'utf8')).map((line) => `${path.relative(repo, f).split(path.sep).join('/')}: ${line}`),
    )
    .sort();
}

test('every way of naming ps as a command is caught', () => {
  for (const hit of [
    "execSync('ps aux');",
    "exec('ps axo pid,ppid', done);",
    "spawn('ps');",
    "const PS = '/bin/ps';",
    "execFile(cond ? 'ps' : 'tasklist', args);",
    'exec(`pid=$(ps -o pid=)`);',
    "exec('sudo ps -ax');",
    "exec('/usr/bin/env ps -ax');",
    "exec('ps\\t-ax');",
    'exec("ps\t-ax");',
    "execFile('ps', ['-o', 'lstart=']);",
    "run('/usr/local/bin/ps', args);",
    'spawn("/usr/bin/ps", []);',
    "exec('cd /; ps -o pid=');",
    "exec('sleep 1 && ps aux | grep x');",
    'sh(`/opt/homebrew/bin/ps -ax`);',
  ]) {
    assert.equal(linesRunningPs(hit).length, 1, hit);
  }
});

test('prose, other names and comments are not', () => {
  for (const miss of [
    "throw new Error('ps and lsof disagree');",
    "log('ps printed no date');",
    "log('no ps to ask');",
    "log('the ps it replaced');",
    "log('caps -x');",
    "'steps';",
    "'maps -x';",
    "fetch('/api/ps-status');",
    "read('/opt/ps/config');",
    "'lsof -p 1';",
    '// read with `ps -E`',
    ' * or `ps -o pid=`',
    '/** `ps -o pid=` */',
    "const x = 1; // not 'ps aux'",
  ]) {
    assert.deepEqual(linesRunningPs(miss), [], miss);
  }
});

test('nothing starts ps in main, the Host or shared code but the one line of relayPeers.cjs', () => {
  assert.deepEqual(runningPs(FOLDERS), KEPT);
  // a second ps in that file is caught, whatever the file is allowed
  const second = `${KEPT[0].split(': ')[1]}\nconst n = await run('/bin/ps', ['-o', 'pgid=', '-p', String(pid)], exec);`;
  assert.equal(linesRunningPs(second).length, 2);
});
