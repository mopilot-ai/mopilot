// What scripts/perf-bench/stdio.mjs reads: a stand-in harness writing JSON lines to stdout, each stamped with the
// monotonic clock it shares with the reader. `steady <rate> <seconds> <bytes>` paces them, `burst <count> <bytes>` writes
// them as fast as stdout takes them, and `record <bytes>` writes one line of that size.
import { writeSync } from 'node:fs';

const [mode, ...numbers] = process.argv.slice(2);
const [first, second, third] = numbers.map(Number);
const now = () => Number(process.hrtime.bigint());
const line = (/** @type {number} */ i, /** @type {string} */ pad) => `{"i":${i},"t":${now()},"pad":"${pad}"}\n`;

/** All of `text` on stdout, however many writes that takes. @param {string} text */
function write(text) {
  const bytes = Buffer.from(text);
  for (let at = 0; at < bytes.length; ) at += writeSync(1, bytes, at);
}

if (mode === 'record') write(line(0, 'x'.repeat(first)));
else if (mode === 'burst') {
  const pad = 'x'.repeat(second);
  for (let i = 0; i < first; i++) write(line(i, pad));
} else {
  const pad = 'x'.repeat(third);
  const gap = 1e9 / first;
  const count = first * second;
  const start = now();
  let i = 0;
  // setImmediate rather than a timer: a line goes out when it is due, not at the next millisecond
  const tick = () => {
    while (i < count && now() >= start + i * gap) write(line(i++, pad));
    if (i < count) setImmediate(tick);
  };
  tick();
}
