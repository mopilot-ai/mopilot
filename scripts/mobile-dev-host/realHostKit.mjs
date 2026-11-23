// DEV ONLY: the acceptance run's own pieces (scripts/host-accept*) and the Mac's enrollment courier, wired for startRealHost: a context made as `host-accept.mjs` makes it, and the courier the app registers (electron/app/ipc/hostPhoneDirect.cjs).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { channelFor, realDeps, runSteps } from '../host-accept.mjs';
import { STEPS, cleanup, hostUp, provideFakeAgent, removeTestAgent, restart, session } from '../host-accept/steps.mjs';
import { startRealHost } from './realHost.mjs';

const require = createRequire(import.meta.url);
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/** What startRealHost takes of the acceptance run. */
export const kit = {
  /** A run's context for the machine, as host-accept's main makes it. @param {string} vm */
  makeCtx(vm) {
    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'host-phone-bridge-'));
    return {
      m: channelFor(/** @type {Parameters<typeof channelFor>[0]} */ ({ vm })),
      deps: realDeps(),
      root: ROOT,
      outDir,
      target: vm,
      nonce: path.basename(outDir).slice(-6),
      state: {},
      opts: {},
    };
  },
  runSteps,
  STEPS,
  session,
  provideFakeAgent,
  restart,
  hostUp,
  removeTestAgent,
  cleanup,
};

/** The Mac's real enrollment courier. */
export const createPhoneEnroll = (/** @type {any} */ o) => require('../../electron/host/phoneEnroll.cjs').createPhoneEnroll(o);

/** A real Host in a Tart VM, as the dev host's `--real-host` has it. @param {{ vm: string, dir: string, log: (text: string) => void, relayPort: number, gateway?: string }} o @param {typeof kit} [k] the acceptance pieces (a test brings stand-ins) */
export const realHostFor = (o, k = kit) => startRealHost({ ...o, kit: k, createPhoneEnroll });
