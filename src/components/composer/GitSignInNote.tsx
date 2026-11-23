// The composer's line (and the hook behind it) when a Host chat's agent's git failed for a missing sign-in (src/lib/hostGitSignIn.ts), read from the chat's latest finished turn; null for a chat on this Mac, while a turn runs, or when nothing failed that way.
import { useMemo } from 'react';
import { useStore } from '../../store/core';
import { navigate } from '../../store/panes';
import { useChatMachine } from '../../lib/chatMachine';
import { gitSignInChatNote, gitSignInHostIn } from '../../lib/hostGitSignIn';
import { RemoteGitSignin } from './RemoteGitSignin';
import { identityKey } from '../../../shared/identityKey.mjs';

function useGitSignInFailure(threadId: string | null) {
  const { machine } = useChatMachine(threadId);
  const running = useStore((s) => (threadId ? !!s.runtime[threadId]?.activeTurnId : false));
  const turn = useStore((s) => (threadId && machine && !running ? s.runtime[threadId]?.turns.at(-1) : undefined));
  return useMemo(() => {
    const host = turn?.items && machine ? gitSignInHostIn(turn.items) : null;
    return host === null || !machine || !turn ? null : { host, machine, turn };
  }, [turn, machine]);
}

export function useGitSignInNote(threadId: string | null): string | null {
  const failure = useGitSignInFailure(threadId);
  return failure ? gitSignInChatNote(failure.host, failure.machine.name) : null;
}

/** The sign-in action above the composer for a Git authentication failure in a remote chat. */
export function GitSignInNote({ threadId }: { threadId: string }) {
  const failure = useGitSignInFailure(threadId);
  if (!failure) return null;
  const { host, machine, turn } = failure;
  const recoveryKey = identityKey(threadId, machine.id, turn.id, host);
  return (
    <RemoteGitSignin
      key={recoveryKey}
      machine={machine}
      host={host}
      recoveryKey={recoveryKey}
      onOpenMachines={() => navigate({ name: 'settings', section: 'connections' })}
    />
  );
}
