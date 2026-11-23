// The built-in semantic handlers each harness runs (src/harness/adapters/semantics.ts): registered by the composition
// root, loaded on first use, since they drive the store.
import { registerSemanticLoader } from '../../../harness/adapters/semantics';

/** Register Codex's and Claude Code's built-in handlers with the semantics registry. */
export function registerSemanticHandlers() {
  registerSemanticLoader('codex', () => import('./codexSemantics').then((m) => m.CODEX_HANDLERS));
  registerSemanticLoader('claude', () => import('./claudeSemantics').then((m) => m.CLAUDE_HANDLERS));
  // Claude Code and Codex on a machine are drawn as ACP chats, whose agent there runs the semantic
  for (const kind of ['acp:host-claude', 'acp:host-codex'] as const)
    registerSemanticLoader(kind, () => import('./hostSemantics').then((m) => m.HOST_HANDLERS));
}
