// Control methods Sage relies on: presence on Query, getContextUsage, mcpServerStatus, rewindFiles,
// and the top-level renameSession / forkSession.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { sdk, open, sleep } from '../lib/claude.mjs';

export const id = 'C14';
export const title = 'Control methods present in the SDK';
export const timeoutMs = 400000;

const METHODS = [
  'getContextUsage',
  'mcpServerStatus',
  'toggleMcpServer',
  'rewindFiles',
  'stopTask',
  'applyFlagSettings',
  'setPermissionMode',
  'backgroundTasks',
  'reinitialize',
  'reloadSkills',
  'setMcpServers',
  'supportedAgents',
  'accountInfo',
  'supportedCommands',
  'initializationResult',
  'interrupt',
];

export default async function run(ctx) {
  const cwd = ctx.cwd('rewind');
  const s = open(ctx, 'session', {
    cwd,
    persist: true,
    permissionMode: 'bypassPermissions',
    allowDangerouslySkipPermissions: true,
    enableFileCheckpointing: true,
  });
  const o = { methods: Object.fromEntries(METHODS.map((k) => [k, typeof s.q[k]])) };
  const read = (f) => (fs.existsSync(path.join(cwd, f)) ? fs.readFileSync(path.join(cwd, f), 'utf8').trim() : null);
  const u1 = crypto.randomUUID();
  const u2 = crypto.randomUUID();
  await s.turn('Use the Write tool to create f.txt containing exactly the line one. Then reply done.', { uuid: u1 }, 120000);
  await s.turn(
    'Use the Write tool to overwrite f.txt so it contains exactly the line two, and also create g.txt containing x. Then reply done.',
    { uuid: u2 },
    120000,
  );
  o.before = { f: read('f.txt'), g: read('g.txt') };
  const usage = await s.q.getContextUsage({ detail: 'summary' });
  o.contextUsage = { categories: usage?.categories?.length ?? 0, totalTokens: usage?.totalTokens ?? null };
  o.mcpServerStatusIsArray = Array.isArray(await s.q.mcpServerStatus());
  const dry = await s.q.rewindFiles(u2, { dryRun: true });
  o.dryRun = { canRewind: dry?.canRewind, filesChanged: (dry?.filesChanged ?? []).map((f) => path.basename(f)).sort() };
  await s.q.rewindFiles(u2);
  o.after = { f: read('f.txt'), g: read('g.txt') };
  const sid = s.sessionId();
  await s.close({ keep: true });
  ctx.defer(() => sdk.deleteSession(sid));
  await sleep(800);
  await sdk.renameSession(sid, 'conformance renamed');
  o.renamedTitle = (await sdk.getSessionInfo(sid))?.customTitle ?? null;
  const fork = await sdk.forkSession(sid, { upToMessageId: u1, title: 'conformance fork' });
  ctx.defer(() => sdk.deleteSession(fork.sessionId));
  o.forkMessages = (await sdk.getSessionMessages(fork.sessionId)).length;
  return ctx.result(o, {
    'all control methods are functions': Object.values(o.methods).every((t) => t === 'function'),
    'getContextUsage returns categories': o.contextUsage.categories > 0,
    'rewindFiles dryRun lists f.txt and g.txt': o.dryRun.canRewind === true && o.dryRun.filesChanged.join() === 'f.txt,g.txt',
    'rewindFiles restores to before the anchored message': o.before.f === 'two' && o.after.f === 'one' && o.after.g === null,
    'renameSession sets customTitle': o.renamedTitle === 'conformance renamed',
    'forkSession(upToMessageId) keeps exactly that message': o.forkMessages === 1,
  });
}
