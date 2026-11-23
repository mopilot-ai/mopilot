// History operations: no thread/rollback; thread/revert, fork, name, list by name, archive/unarchive.
import { open, errMsg, sleep } from '../lib/codex.mjs';

export const id = 'X8';
export const title = 'revert vs rollback, fork, name, archive, search';
export const timeoutMs = 300000;

export default async function run(ctx) {
  const c = await open(ctx, 'session');
  const tid = (await c.startThread()).result.thread.id;
  const a = await c.turn(tid, 'Reply with exactly: alpha', {}, 90000);
  const b = await c.turn(tid, 'Reply with exactly: beta', {}, 90000);
  const turnIds = async (id) => ((await c.request('thread/turns/list', { threadId: id })).result?.data ?? []).map((x) => x.id);
  const since = (from, m) => c.notes.slice(from).filter((n) => n.method === m && n.params?.threadId === tid);
  const o = { rollbackError: errMsg(await c.request('thread/rollback', { threadId: tid, numTurns: 1 }))?.slice(0, 80) ?? null };

  const fork = await c.request('thread/fork', { threadId: tid, lastTurnId: a.turnId, excludeTurns: true });
  const fid = fork.result?.thread?.id;
  o.fork = { error: errMsg(fork), forkedFromParent: fork.result?.thread?.forkedFromId === tid, turns: fid ? await turnIds(fid) : null };

  let from = c.notes.length;
  const rev = await c.request('thread/revert', { threadId: tid, beforeTurnId: b.turnId });
  await sleep(500);
  o.revert = { error: errMsg(rev), revertedNote: since(from, 'thread/reverted').length > 0, turnsAfter: await turnIds(tid) };

  const name = `sage-conformance-${Date.now().toString(36)}`;
  from = c.notes.length;
  await c.request('thread/name/set', { threadId: tid, name });
  await sleep(500);
  o.name = {
    updatedNote: since(from, 'thread/name/updated').some((n) => n.params.threadName === name),
    listByName: ((await c.request('thread/list', { searchTerm: name, limit: 5 })).result?.data ?? []).map((x) => x.id).includes(tid),
  };
  const search = await c.request('thread/search', { searchTerm: name, limit: 5 });
  o.searchImmediately = search.error ? errMsg(search) : (search.result?.data ?? []).length;

  from = c.notes.length;
  const arch = await c.request('thread/archive', { threadId: tid });
  await sleep(500);
  o.archive = {
    error: errMsg(arch),
    archivedNote: c.notes.slice(from).some((n) => n.method === 'thread/archived'),
    unarchive: errMsg(await c.request('thread/unarchive', { threadId: tid })),
  };
  return ctx.result(o, {
    'thread/rollback does not exist': /unknown variant/.test(o.rollbackError ?? ''),
    'thread/fork keeps turns up to lastTurnId':
      !o.fork.error && o.fork.forkedFromParent && o.fork.turns?.length === 1 && o.fork.turns[0] === a.turnId,
    'thread/revert drops the turn and emits thread/reverted':
      !o.revert.error && o.revert.revertedNote && o.revert.turnsAfter.length === 1 && o.revert.turnsAfter[0] === a.turnId,
    'thread/name/set emits thread/name/updated; thread/list finds it': o.name.updatedNote && o.name.listByName,
    'archive emits thread/archived; unarchive works': !o.archive.error && o.archive.archivedNote && o.archive.unarchive === null,
  });
}
