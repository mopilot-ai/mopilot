// The harness runtime the store drives: each harness family's own start, chats, turns, requests and tasks. The
// composition root installs it (src/main.tsx) before boot, so the store reaches the harness modules without importing
// them: they import the store, and an import back would close a cycle (docs/architecture/modularization.md step 3).
import type { AgentThreadLoader } from './agentThreads';
import type { TaskStopper } from './backgroundTasks';
import type { PendingRequest, Thread, TurnState } from './types';

type BackgroundTask = Parameters<TaskStopper>[1];

export interface HarnessRuntime {
  // Claude Code
  startClaude(): void;
  loadClaudeThreads(): Promise<void>;
  loadArchivedClaudeInfo(): Promise<void>;
  archivedClaudeThreads(): Thread[];
  archivedCodexMissing(): boolean;
  searchClaudeThreads(term: string, scope?: string): Promise<Thread[]>;
  rememberClaudeThread(t: Thread | undefined): void;
  startClaudeThread(opts: { cwd: string; projectId?: string | null; ephemeral?: boolean; sid?: string | null }): string;
  markNewClaudeSession(nativeId: string): void;
  openClaudeThread(id: string): Promise<void>;
  openClaudeSideChat(chatId: string, nativeId: string, selection?: string, replaceTabId?: string): string;
  loadOlderClaudeTurns(id: string, cursor: string): Promise<{ turns: TurnState[]; nextCursor: string | null }>;
  claudeEditMessage(chatId: string, turnId: string): Promise<boolean>;
  claudeStop(threadId: string, turnId?: string): Promise<void | 'retired' | true>;
  claudeStopAllTasks(threadId: string, keys?: string[]): Promise<void>;
  setClaudeUltracode(threadId: string, on: boolean): Promise<void>;
  claudeMoveToBackground(threadId: string): Promise<boolean>;
  stopClaudeTask: TaskStopper;
  loadClaudeAgentThread: AgentThreadLoader;
  readClaudeTaskOutput(task: BackgroundTask): Promise<string | null>;
  resolveClaudeRequest(req: PendingRequest, result: unknown): Promise<boolean>;
  // basic (ACP) harnesses
  startAcp(): void;
  acpLabelOf(nativeId: string): string;
  loadOlderAcpTurns(id: string, cursor: string): Promise<{ turns: TurnState[]; nextCursor: string | null }>;
  loadAcpThreads(): Promise<void>;
  archivedAcpThreads(): Promise<Thread[]>;
  searchAcpThreads(term: string, scope?: string): Promise<Thread[]>;
  startAcpThread(o: { cwd: string; projectId?: string | null; harness: string }): string;
  startHostAcpThread(o: {
    host: { id: string; path: string; scope?: string };
    projectId?: string | null;
    harness: string;
  }): Promise<string>;
  openAcpThread(id: string): Promise<void>;
  acpRename(id: string, name: string): Promise<{ error: string; hostId?: string } | null>;
  acpInterrupt(threadId: string, turnId?: string): Promise<'retired' | boolean | undefined>;
  loadAcpAgentThread: AgentThreadLoader;
  resolveAcpRequest(req: PendingRequest, result: unknown): Promise<boolean>;
  // Codex, and a chat that switched harnesses
  pauseCodexGoal(chatId: string, turnId?: string): Promise<void>;
  openCompositeThread(chatId: string): Promise<void>;
  forkSwitchedChat(
    chatId: string,
    turnId: string | undefined,
    rename: (id: string, name: string) => Promise<void>,
  ): Promise<string | undefined>;
  // every harness: main's runs of the harness CLIs
  followHarnessRuns(): void;
}

let installed: HarnessRuntime | null = null;

/** Installs the runtime the store calls, and returns the one it replaced (a test puts that back). */
export function installRuntime(next: HarnessRuntime | null): HarnessRuntime | null {
  const previous = installed;
  installed = next;
  return previous;
}

/** The installed runtime. Before src/main.tsx installs it there is none, and a call says so instead of doing nothing. */
export function runtime(): HarnessRuntime {
  if (!installed) throw new Error('The harness runtime is not installed: src/main.tsx installs it before boot.');
  return installed;
}
