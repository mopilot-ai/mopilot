// Less frequent chat actions live in the chat header's Utilities submenu rather than the sidebar menu.
import type { Thread } from '../../store/types';
import { toastFailure } from '../../store/core';
import { native } from '../../lib/native';
import { revealPath } from '../../session/open';
import { useOrchestrationSelect } from '../../lib/sideSessions';
import { MenuItem, SubMenu } from '../ui/Popover';

export function ChatUtilityItems({ thread }: { thread: Thread }) {
  const child = useOrchestrationSelect((v) => v.children[thread.id]);
  const detachable = child && !child.detached;
  if (!thread.path && !detachable) return null;
  return (
    <SubMenu label="Utilities">
      {thread.path && <MenuItem onSelect={() => revealPath(thread.path!)}>Reveal session file</MenuItem>}
      {detachable && (
        <MenuItem
          onSelect={() => native.orchestration.child(thread.id, 'detach').catch(toastFailure("Couldn't detach the session. Try again."))}
        >
          Detach to top level
        </MenuItem>
      )}
    </SubMenu>
  );
}
