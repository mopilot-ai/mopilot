// window.native.git: git and gh commands, worktrees and patches (electron/platform/git.cjs, electron/app/ipc/files.cjs).
const { invoke } = require('./spec.cjs');

module.exports = {
  sidebarRepository: invoke('git:sidebarRepository', 1),
  info: invoke('git:info', 1),
  status: invoke('git:status', 2),
  diff: invoke('git:diff', 3),
  run: invoke('git:run', 2),
  commitFiles: invoke('git:commitFiles', 3),
  gh: invoke('gh:run', 2),
  worktreeAdd: invoke('git:worktreeAdd', 2),
  branches: invoke('git:branches', 1),
  switchBranch: invoke('git:switchBranch', 2),
  startSource: invoke('git:startSource', 2),
  fetchPullRequest: invoke('git:fetchPullRequest', 2),
  issue: invoke('git:issue', 2),
  worktreeInfo: invoke('git:worktreeInfo', 1),
  worktreeList: invoke('git:worktreeList', 1),
  worktreeAdopted: invoke('git:worktreeAdopted', 1),
  worktreeRestore: invoke('git:worktreeRestore', 4),
  worktreePrune: invoke('git:worktreePrune', 3),
  worktreeArchive: invoke('git:worktreeArchive', 1),
  applyPatch: invoke('git:applyPatch', 3),
};
