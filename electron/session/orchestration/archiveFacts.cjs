// Automatic family archival requires fresh authoritative worktree and PR reads; failed or retired reads keep the chat.
async function quietWorktree(orch, id) {
  const child = orch.journal.child(id);
  if (!child?.useWorktree) return true;
  const native = orch.o.controller.ref(id).key;
  const epoch = orch.o.chats.archiveEpoch?.(id) ?? orch.o.chats.records.get(id)?.meta?.activeAt ?? null;
  const revision = orch.o.controller.state.get(id).rev;
  const current = () =>
    orch.journal.child(id)?.cwd === child.cwd &&
    orch.journal.child(id)?.parentId === child.parentId &&
    orch.journal.child(id)?.detached === child.detached &&
    orch.o.chats.records.has(id) &&
    !orch.o.chats.isDeleted?.(id) &&
    (orch.o.chats.archiveEpoch?.(id) ?? orch.o.chats.records.get(id)?.meta?.activeAt ?? null) === epoch &&
    orch.o.controller.ref(id).key === native &&
    orch.o.controller.state.get(id).rev === revision &&
    !orch.archived(id);
  try {
    const [status, branch] = await Promise.all([
      orch.o.run.git(['status', '--porcelain=v1', '-uall'], child.cwd, 10000),
      orch.o.run.git(['rev-parse', '--abbrev-ref', 'HEAD'], child.cwd, 10000),
    ]);
    if (!current() || !status.ok || status.stdout.trim() || !branch.ok) return false;
    const name = branch.stdout.trim();
    if (!name || name === 'HEAD' || name.startsWith('-')) return false;
    const pr = await orch.o.run.gh(['pr', 'list', '--head', name, '--state', 'open', '--limit', '1', '--json', 'number'], child.cwd, 15000);
    if (!current() || !pr.ok) return false;
    const list = JSON.parse(pr.stdout);
    return Array.isArray(list) && list.length === 0;
  } catch {
    // Unknown git/PR state is an attention hold, never evidence of a clean or finished child.
    return false;
  }
}

module.exports = { quietWorktree };
