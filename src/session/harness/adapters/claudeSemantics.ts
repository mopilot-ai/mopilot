// How a Claude Code chat runs a semantic (src/store/session/runSemantic.ts): goals, rename, shell
// commands and fork, through the SDK session main holds and the Claude helpers in src/session/harness/claude.ts.
import { ownTable } from '../../../../shared/ownTable.mjs';
import { editClaudeMessage } from '../../../store/actions';
import { nativeOf } from '../../../store/chats';
import { navigate } from '../../../store/panes';
import { toast } from '../../../store/core';
import { chatProxy } from '../../../harness/adapters/proxy';
import type { Semantic } from '../../../harness/adapter';
import { claudeClearGoal, claudeExtendGoal, claudeFork, claudePauseGoal, claudeRename, claudeResumeGoal } from '../claude';
import { unsupportedGoal, type SemanticHandler } from '../../../harness/adapters/semantics';

async function fork(threadId: string, turnId?: string) {
  const id = await claudeFork(threadId, turnId);
  navigate({ name: 'thread', id });
  toast('Forked into a new chat');
  return id;
}

export const CLAUDE_HANDLERS: Partial<Record<Semantic, SemanticHandler>> = ownTable({
  // args: pause | resume | extend (10 more rounds) | clear | clear human (the user typed /goal clear)
  // anything else (a Codex goal's edit or budget, after the chat switched) is refused, never taken as a clear
  goal: ({ chatId, args }) =>
    args === 'pause'
      ? claudePauseGoal(chatId)
      : args === 'resume'
        ? claudeResumeGoal(chatId)
        : args === 'extend'
          ? claudeExtendGoal(chatId)
          : args === 'clear' || args === 'clear human'
            ? claudeClearGoal(chatId, args === 'clear human')
            : unsupportedGoal('Claude Code', args),
  rename: ({ chatId, args }) => claudeRename(chatId, args),
  // typed into the session as its own text, the way the CLI takes them
  shell: ({ chatId, args }) => chatProxy.send(chatId, `!${args}`),
  fork: ({ chatId, args }) => fork(nativeOf(chatId), args || undefined),
  // args: the turn to go back to before; true once the chat is rewound
  rewind: ({ chatId, args }) => editClaudeMessage(chatId, args),
});
