// Per-account/folder Claude commands and skills, plus shared command-provider selection.
import { useEffect, useMemo } from 'react';
import { native } from '../../../lib/native';
import { noteIgnored } from '../../../lib/ignored';
import { useStore, get as getState, set as setState } from '../../../store/core';
import { claudeCommands, codexCommands, type CommandProvider } from '../../../harness/commands';
import { useComposerFamily } from '../select';
import { claudeChatAccount } from './accounts';
import type { ClaudeSkillFile } from '../../../../shared/model/native';
export const catalogKey = (account: string, cwd: string) => `${account}\u0000${cwd}`;
const fetchingCatalog = new Set<string>();

/**
 * The chat's command provider when it runs on Claude (null otherwise): supportedCommands with
 * aliases, its skills, without the interactive-only and terminal-only commands. A folder no Claude
 * session has run in yet is prefetched once.
 */
export function useClaudeCommands(threadId: string | null, cwd: string): CommandProvider | null {
  const claude = useComposerFamily(threadId) === 'claude';
  const account = useStore((s) => (threadId ? claudeChatAccount(threadId) : s.claudeAccounts.active));
  const key = catalogKey(account, cwd);
  const cat = useStore((s) => s.claudeCatalogs[key]);
  useEffect(() => {
    if (!claude || cat || !cwd || fetchingCatalog.has(key) || !getState().claude.status.bin) return;
    fetchingCatalog.add(key);
    native.claude
      .catalog(getState().prefs.claudeBin, cwd, account)
      .then((c) => c && setState((s) => ({ claudeCatalogs: { ...s.claudeCatalogs, [key]: c } })))
      // no catalog: the / menu lists no Claude commands until main pushes one (onCatalog) or the folder or account changes
      .catch((error) => noteIgnored("read Claude Code's commands and skills for a folder", error))
      .finally(() => fetchingCatalog.delete(key));
  }, [claude, cat, cwd, key, account]);
  return useMemo(
    () => (claude && cat ? claudeCommands(cat.commands, { terminalSlash: cat.terminalSlash ?? undefined, skills: cat.skills }) : null),
    [claude, cat],
  );
}

const CODEX_PROVIDER = codexCommands();

/**
 * The chat's command provider whichever first-class harness it runs on: Claude's catalog, or Codex's static table.
 * A basic harness's chat has neither: its commands are the ones it listed (acpRegistry).
 */
export function useCommandProvider(threadId: string | null, cwd: string): CommandProvider | null {
  const claude = useClaudeCommands(threadId, cwd);
  const codex = useComposerFamily(threadId) === 'codex';
  return claude ?? (codex ? CODEX_PROVIDER : null);
}

/** Claude's skills for the / menu, from the catalog. */
export function useClaudeSkills(threadId: string | null, cwd: string): string[] | null {
  const claude = useComposerFamily(threadId) === 'claude';
  const account = useStore((s) => (threadId ? claudeChatAccount(threadId) : s.claudeAccounts.active));
  const cat = useStore((s) => s.claudeCatalogs[catalogKey(account, cwd)]);
  return claude ? (cat?.skills ?? []) : null;
}

/** Where Claude's skills are on this Mac, from the catalog: name -> SKILL.md (null for a chat on another harness). */
export function useClaudeSkillFiles(threadId: string | null, cwd: string): Record<string, ClaudeSkillFile> | null {
  const claude = useComposerFamily(threadId) === 'claude';
  const account = useStore((s) => (threadId ? claudeChatAccount(threadId) : s.claudeAccounts.active));
  const cat = useStore((s) => s.claudeCatalogs[catalogKey(account, cwd)]);
  return claude ? (cat?.skillFiles ?? NO_FILES) : null;
}
const NO_FILES: Record<string, ClaudeSkillFile> = {};
