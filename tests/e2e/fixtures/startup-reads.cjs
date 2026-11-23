// Loaded into the app's main process before it starts (the `mainRequire` fixture option, Electron's -r) by the startup
// heap budget journey: which Claude Code transcripts main reads whole (the Agent SDK's readFile, a line stream), and the
// peak of main's V8 heap, sampled from boot. Read back through global.__startupReads.
const fs = require('node:fs');
const path = require('node:path');
const v8 = require('node:v8');

const read = new Set();
let peak = 0;
const PROJECTS = `${path.sep}projects${path.sep}`;
const note = (file) => {
  const p = String(file);
  if (p.endsWith('.jsonl') && p.includes(PROJECTS)) read.add(p);
};
const readFile = fs.promises.readFile;
fs.promises.readFile = function (file, ...rest) {
  note(file);
  return readFile.call(this, file, ...rest);
};
const createReadStream = fs.createReadStream;
fs.createReadStream = function (file, ...rest) {
  note(file);
  return createReadStream.call(this, file, ...rest);
};
setInterval(() => {
  peak = Math.max(peak, v8.getHeapStatistics().used_heap_size);
}, 100).unref();

global.__startupReads = { transcripts: () => [...read], peakHeap: () => peak };
