// The harness runtime the store drives, as the harness modules provide it: src/main.tsx installs it in the store
// (src/store/runtime.ts), which never imports these modules, since they import the store.
import * as claude from './claude';
import { loadOlderClaudeTurns } from './claude/history';
import { loadClaudeAgentThread, readClaudeTaskOutput } from './claudeAgents';
import * as acp from './acp';
import * as acpHost from './acpHost';
import { loadAcpAgentThread } from './acpAgents';
import { pauseCodexGoal } from './adapters/codexSemantics';
import { openCompositeThread } from './switch';
import { forkSwitchedChat } from './forkSwitched';
import { followHarnessRuns } from './harnessRuns';

/** Each function the store calls on the harnesses, by the name the store's HarnessRuntime gives it. */
export const harnessRuntime = () => ({
  startClaude: claude.startClaude,
  loadClaudeThreads: claude.loadClaudeThreads,
  loadArchivedClaudeInfo: claude.loadArchivedClaudeInfo,
  archivedClaudeThreads: claude.archivedClaudeThreads,
  archivedCodexMissing: claude.archivedCodexMissing,
  searchClaudeThreads: claude.searchClaudeThreads,
  rememberClaudeThread: claude.rememberClaudeThread,
  startClaudeThread: claude.startClaudeThread,
  markNewClaudeSession: claude.markNewClaudeSession,
  openClaudeThread: claude.openClaudeThread,
  openClaudeSideChat: claude.openClaudeSideChat,
  loadOlderClaudeTurns,
  claudeEditMessage: claude.claudeEditMessage,
  claudeStop: claude.claudeStop,
  claudeStopAllTasks: claude.claudeStopAllTasks,
  setClaudeUltracode: claude.setClaudeUltracode,
  claudeMoveToBackground: claude.claudeMoveToBackground,
  stopClaudeTask: claude.stopClaudeTask,
  loadClaudeAgentThread,
  readClaudeTaskOutput,
  resolveClaudeRequest: claude.resolveClaudeRequest,
  startAcp: acp.startAcp,
  acpLabelOf: acp.acpLabelOf,
  loadOlderAcpTurns: acp.loadOlderAcpTurns,
  loadAcpThreads: acp.loadAcpThreads,
  archivedAcpThreads: acp.archivedAcpThreads,
  searchAcpThreads: acp.searchAcpThreads,
  startAcpThread: acp.startAcpThread,
  startHostAcpThread: acpHost.startHostAcpThread,
  openAcpThread: acp.openAcpThread,
  acpRename: acp.acpRename,
  acpInterrupt: acp.acpInterrupt,
  loadAcpAgentThread,
  resolveAcpRequest: acp.resolveAcpRequest,
  pauseCodexGoal,
  openCompositeThread,
  forkSwitchedChat,
  followHarnessRuns,
});
