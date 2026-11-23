// Claude Code's sign-in terminal, shown in Settings wherever its sign-in was started (Accounts & billing, its page).
import { get as getState } from '../../store/core';
import { endClaudeLoginTerm, useClaudeLoginTerm } from '../../session/harness/claude';
import { TermView } from '../panels/TerminalPanel';

/** The `claude auth login` running for an added or lapsed login; nothing while none runs. */
export function ClaudeLoginTerm() {
  const loginTerm = useClaudeLoginTerm();
  if (!loginTerm) return null;
  return (
    <div className="basic-login-term">
      <TermView
        tab={{ id: loginTerm.id, cwd: getState().home, title: loginTerm.title, command: loginTerm.command, signIn: true }}
        visible
        onExit={endClaudeLoginTerm}
      />
    </div>
  );
}
