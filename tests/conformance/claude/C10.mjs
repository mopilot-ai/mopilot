// persistSession:false writes no transcript and the session is not listed.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { sdk, open, sleep } from '../lib/claude.mjs';

export const id = 'C10';
export const title = 'persistSession:false';
export const timeoutMs = 240000;

const jsonlExists = (sid) => {
  const root = path.join(os.homedir(), '.claude/projects');
  return fs.readdirSync(root).some((d) => fs.existsSync(path.join(root, d, `${sid}.jsonl`)));
};

export default async function run(ctx) {
  const cwd = ctx.cwd('session');
  const s = open(ctx, 'session', { cwd, persist: false });
  await s.turn('Reply with just ok.', {}, 120000);
  const sid = s.sessionId();
  await sleep(800);
  const o = {
    jsonlDuring: jsonlExists(sid),
    listedForCwd: (await sdk.listSessions({ dir: cwd })).some((x) => x.sessionId === sid),
    inRecent50: (await sdk.listSessions({ limit: 50 })).some((x) => x.sessionId === sid),
    info: (await sdk.getSessionInfo(sid)) ?? null,
  };
  await s.close();
  await sleep(800);
  o.jsonlAfterClose = jsonlExists(sid);
  return ctx.result(o, {
    'no transcript during or after the session': !o.jsonlDuring && !o.jsonlAfterClose,
    'not listed by listSessions': !o.listedForCwd && !o.inRecent50,
    'getSessionInfo is undefined': o.info === null,
  });
}
