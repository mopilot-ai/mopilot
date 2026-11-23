// A Host's real Claude sessions with MoMo's home and chats over them, for the tests of MoMo's chats on a Host.
import fs from 'node:fs';
import path from 'node:path';
// @ts-ignore: plain ESM without declarations
import { createMomoHome } from '../../../host/src/momoHome.mjs';
// @ts-ignore
import { createMomoChats } from '../../../host/src/momoChats.mjs';
// @ts-ignore
import { createFileSafeStorage } from '../../../host/src/secretStore.mjs';
// @ts-ignore
import { createEpochStore } from '../../../host/src/epochs.mjs';
import { base, setup } from './claudeKit.ts';

export const MOMO = ['momo'];
export const quiet = { report: () => undefined };
/** opencode runs MoMo only with a provider; this one is the environment's, so no test reads the machine's own logins. */
export const PROVIDER_ENV = { ANTHROPIC_API_KEY: 'test-key', HOME: '/nonexistent-home', XDG_DATA_HOME: '/nonexistent-data' };

/** A Host's real Claude sessions with MoMo's home and chats over them; `isolate` says whether the isolation was applied at boot. */
export async function world({ isolate = true, granted = true, started = true } = {}) {
  const h = setup();
  const momoDir = fs.mkdtempSync(path.join(base, 'momo-'));
  const home = createMomoHome({
    hostId: 'home-aaaa-1111',
    dataDir: momoDir,
    safeStorage: createFileSafeStorage(path.join(momoDir, 'config')),
  });
  if (granted) await home.grant({ account: 'a1', features: MOMO });
  if (granted && started) await home.start({ name: 'Studio' });
  const epochs = createEpochStore(path.join(momoDir, 'e.json'), quiet);
  const make = (sessions: any = h.sessions) => {
    const chats = createMomoChats({ home, sessions, epochs, env: PROVIDER_ENV, report: () => undefined });
    return chats;
  };
  const chats = make();
  home.chats = chats;
  if (isolate) h.sessions.isolate(chats.isMomoChat, chats.workspace);
  return { h, home, chats, epochs, momoDir, make };
}
