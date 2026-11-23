// The new-chat suggestion to turn on Worktree while another chat runs in the same folder (as in Claude Code's desktop app).
import { useShallow } from 'zustand/react/shallow';
import { useStore, set as setState } from '../../store/core';
import { newChatWorktreeOn } from '../../store/chats';
import { useSessions } from '../../store/session/useSession';
import { runningInFolder, sessionBusy } from '../../session/chatRunning';
import { useWorktreeSupport } from '../../lib/branchList';
import { Split, X } from '../ui/icons';

/**
 * Shown while another chat, on any harness, has a turn under way in `path` itself and this draft has Worktree off.
 * Turning it on here is for this draft only (the switch's saved default stays); dismissing hides it for this draft's
 * folder. A folder that can't hold a worktree never shows it.
 */
export function WorktreeHint({ path }: { path: string }) {
  // re-rendered when a chat's turn starts or ends, not on every patch of a streaming chat
  const busyChats = useSessions(useShallow((s) => sessionBusy(s.sessions)));
  const busy = useStore((s) => runningInFolder(path, s, busyChats));
  const open = useStore((s) => !newChatWorktreeOn(s) && s.newChatWorktreeHintOff !== path);
  // read only while the suggestion would show, so a folder no other chat runs in costs no git call
  const noWorktree = useWorktreeSupport(path, busy && open);
  if (!busy || !open || noWorktree !== null) return null;
  return (
    <div className="fa-banner wt-hint" role="status">
      <Split size={16} strokeWidth={1.8} className="fa-icon" />
      <div className="fa-text">
        <div className="fa-title">Turn on Worktree</div>
        Another chat runs in this folder. A worktree keeps their changes apart.
      </div>
      <span className="fa-sep" />
      <button className="fa-dont" onClick={() => setState({ newChatWorktree: true })}>
        Turn on
      </button>
      <button className="icon-btn xs" aria-label="Dismiss" onClick={() => setState({ newChatWorktreeHintOff: path })}>
        <X size={13} />
      </button>
    </div>
  );
}
