// Which app a setup item Codex detected for import came from (Cursor, Claude Cowork, Claude Code), read from its text:
// Settings groups the items by it, and a new chat imports only the sources the user turned on.
import type { ExternalAgentConfigMigrationItem } from '../protocol/v2/ExternalAgentConfigMigrationItem';

export function importSource(it: ExternalAgentConfigMigrationItem): { id: string; name: string } {
  const text = JSON.stringify(it);
  if (/\.cursor\b|Cursor/.test(text)) return { id: 'cursor', name: 'Cursor' };
  if (/claude-cowork|Claude Cowork/i.test(text)) return { id: 'claude-cowork', name: 'Claude Cowork' };
  if (/\.claude\b|CLAUDE\.md|claude/i.test(text)) return { id: 'claude-code', name: 'Claude Code' };
  return { id: 'other', name: it.description };
}
