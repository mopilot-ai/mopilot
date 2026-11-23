// Main's per-file load times (electron/perf/requireTimes.cjs): own time without nested requires, and the slowest files.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const times = require('../electron/perf/requireTimes.cjs');

/** A Module whose _compile runs `bodies[filename]`, which may compile nested files, on a clock the bodies move. */
function fakeModule(bodies: Record<string, (compile: (f: string) => void) => void>) {
  const clock = { ms: 0 };
  const Module: any = { prototype: {} };
  Module.prototype._compile = function (_content: string, filename: string) {
    bodies[filename]((f) => Module.prototype._compile.call(this, '', f));
    return `ran ${filename}`;
  };
  return { Module, clock, now: () => clock.ms };
}

test("each file's own time leaves out the files it required; the slowest come first, named from the root", (t) => {
  times.resetRequireTimes();
  t.after(() => times.resetRequireTimes());
  const { Module, clock, now } = fakeModule({
    '/r/a.cjs': (compile) => {
      clock.ms += 2;
      compile('/r/b.cjs');
      clock.ms += 1;
      compile('/r/c.cjs');
    },
    '/r/b.cjs': () => {
      clock.ms += 10;
    },
    '/r/c.cjs': (compile) => {
      clock.ms += 0.25;
      compile('/r/lib/d.cjs');
    },
    '/r/lib/d.cjs': () => {
      clock.ms += 4.04;
    },
  });
  const original = Module.prototype._compile;
  const undo = times.timeRequires(Module, now);
  assert.equal(Module.prototype._compile.call({}, '', '/r/a.cjs'), 'ran /r/a.cjs');
  assert.deepEqual(times.slowestRequires(3, '/r'), {
    files: 4,
    ms: 17.3,
    slowest: [
      { file: 'b.cjs', ms: 10 },
      { file: 'lib/d.cjs', ms: 4 },
      { file: 'a.cjs', ms: 3 },
    ],
    // by folder (or package): ./ holds a, b and c
    packages: [
      { name: './', ms: 13.3 },
      { name: './lib', ms: 4 },
    ],
  });
  // a file compiled again adds to its time
  Module.prototype._compile.call({}, '', '/r/b.cjs');
  assert.equal(times.slowestRequires(1, '/r').slowest[0].ms, 20);
  undo();
  assert.equal(Module.prototype._compile, original);
});

test('a file that throws while loading still counts, and so does the time it took in the file requiring it', (t) => {
  times.resetRequireTimes();
  t.after(() => times.resetRequireTimes());
  const { Module, clock, now } = fakeModule({
    '/r/a.cjs': (compile) => {
      clock.ms += 1;
      try {
        compile('/r/bad.cjs');
      } catch {}
    },
    '/r/bad.cjs': () => {
      clock.ms += 5;
      throw new Error('boom');
    },
  });
  const undo = times.timeRequires(Module, now);
  Module.prototype._compile.call({}, '', '/r/a.cjs');
  undo();
  assert.deepEqual(times.slowestRequires(30, '/r').slowest, [
    { file: 'bad.cjs', ms: 5 },
    { file: 'a.cjs', ms: 1 },
  ]);
});

test("by default it times this process's own requires, named from the app's root, until undone", (t) => {
  times.resetRequireTimes();
  t.after(() => times.resetRequireTimes());
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'require-times-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'timed.cjs');
  fs.writeFileSync(file, 'module.exports = 1;\n');
  const undo = times.timeRequires();
  try {
    assert.equal(require(file), 1);
  } finally {
    undo();
  }
  const { files, slowest } = times.slowestRequires();
  assert.equal(files, 1);
  assert.equal(slowest[0].file, path.relative(path.join(import.meta.dirname, '..'), file));
  // undone: later requires are not timed
  fs.writeFileSync(path.join(dir, 'later.cjs'), 'module.exports = 2;\n');
  require(path.join(dir, 'later.cjs'));
  assert.equal(times.slowestRequires().files, 1);
});
