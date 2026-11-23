// Marker files in a fake Claude login's folder that change what the fake CLI does (".fake-limited", ".fake-usage-full", ".fake-status-hold").
import fs from 'node:fs';
import path from 'node:path';

/** Whether the folder holds the marker as its own file: account folders link the shared ~/.claude entries. */
export const marked = (dir, name) => fs.lstatSync(path.join(dir, name), { throwIfNoEntry: false })?.isFile() === true;

/** Waits (until a 15 s deadline) while the folder holds the marker, so a test decides when the call it is held in answers. */
export function holdWhileMarked(dir, name) {
  const deadline = Date.now() + 15_000;
  while (marked(dir, name) && Date.now() < deadline) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
}
