// Crash injection for the MoMo home evals: wraps node:fs so a machine's folder can be killed at its Nth state-changing call, after which nothing of that machine's process can change a file.
import fs from 'node:fs';

/** Thrown inside the killed machine's code; the caller on the other side of the link sees a lost connection, never this. */
export class Crash extends Error {
  code = 'crash';
  constructor() {
    super('machine killed');
  }
}

export type Victim = { root: string; dead: boolean; countdown: number | null; mutations: number };
const victims: Victim[] = [];
export const realRmSync = fs.rmSync.bind(fs);

/** Count a state change under a victim's root, and die when its countdown runs out. */
function check(...paths: unknown[]) {
  for (const p of paths) {
    if (typeof p !== 'string') continue;
    const v = victims.find((x) => p.startsWith(x.root));
    if (!v) continue;
    if (v.dead) throw new Crash();
    v.mutations++;
    if (v.countdown !== null && --v.countdown === 0) {
      v.dead = true;
      throw new Crash();
    }
    return;
  }
}

let installed = false;
/** Wrap the state-changing calls once per process; a call outside every registered root passes straight through. */
export function installFaultFs() {
  if (installed) return;
  installed = true;
  const f: any = fs;
  const p: any = fs.promises;
  for (const name of ['renameSync', 'rmSync', 'writeFileSync', 'linkSync', 'truncateSync']) {
    const real = f[name];
    f[name] = (...args: unknown[]) => {
      check(args[0], name === 'renameSync' || name === 'linkSync' ? args[1] : undefined);
      return real.apply(fs, args);
    };
  }
  for (const name of ['rename', 'rm', 'truncate', 'writeFile', 'appendFile']) {
    const real = p[name];
    p[name] = async (...args: unknown[]) => {
      check(args[0], name === 'rename' ? args[1] : undefined);
      return real.apply(fs.promises, args);
    };
  }
  // durability is modelled by the kill points, so a flush to the disk only costs time here
  f.fsyncSync = () => undefined;
  f.fdatasyncSync = () => undefined;
  const realOpen = p.open;
  // appends to the audit log are state changes; reading and the temp files of an atomic write are not counted separately
  p.open = async (...args: unknown[]) => {
    const flags = String(args[1] ?? 'r');
    if (flags.startsWith('a')) check(args[0]);
    else if (flags !== 'r') {
      const v = victims.find((x) => typeof args[0] === 'string' && args[0].startsWith(x.root));
      if (v?.dead) throw new Crash();
    }
    const handle = await realOpen.apply(fs.promises, args);
    const proto = Object.getPrototypeOf(handle);
    if (!proto.__fastSync) {
      proto.sync = async () => undefined;
      proto.datasync = async () => undefined;
      proto.__fastSync = true;
    }
    return handle;
  };
}

/** Register a machine's folder as killable. */
export function victim(root: string): Victim {
  installFaultFs();
  const v: Victim = { root, dead: false, countdown: null, mutations: 0 };
  victims.push(v);
  return v;
}
export function forget(v: Victim) {
  victims.splice(victims.indexOf(v), 1);
}
