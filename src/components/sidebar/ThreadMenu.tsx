// The sidebar's shared ellipsis and right-click menu: everyday chat actions, with menu-local letter shortcuts.
import { useChatMachine, useFolderHere, usePullRequestFolder } from '../../lib/chatMachine';
import { useEffect, useState, type ComponentProps } from 'react';
import { archiveThread, deleteThread, forkThread } from '../../store/actions';
import { nativeOf } from '../../store/chats';
import { set as setState, toastFailure, useStore } from '../../store/core';
import type { Thread } from '../../store/types';
import { openChat, OPEN_IN } from '../../session/openChat';
import { openLink } from '../../session/open';
import { readPullRequest } from '../../session/pullRequestReader';
import { deleteChatQuestion, deleteMachineName } from '../../lib/deleteChatQuestion';
import { hostAgentOf } from '../../store/hostAgent';
import { historyVersion, type ThreadPullRequest } from '../../lib/threadPullRequest';
import { Menu, MenuItem, MenuSeparator, SubMenu, type Placement } from '../ui/Popover';
import { OpenInItems } from '../titleBar/OpenInApps';
import { MenuLetters } from '../ui/MenuLetters';

export function ThreadMenu({
  thread,
  anchor,
  open,
  onClose,
  onRename,
  pinned,
  placement = 'bottom-start',
}: {
  thread: Thread;
  anchor: HTMLElement | null | { x: number; y: number };
  open: boolean;
  onClose: () => void;
  onRename: () => void;
  pinned: boolean;
  placement?: Placement;
}) {
  const nativeId = useStore(() => nativeOf(thread.id));
  const completed = useStore((s) => s.runtime[thread.id]?.turns?.findLast((turn) => turn.status === 'completed'));
  const version = historyVersion(thread.updatedAt, nativeId);
  const folder = useFolderHere(thread.id, thread.cwd);
  const { machine, pending: machinePending } = useChatMachine(thread.id);
  // this Mac's folder, or the chat's machine's (its Host says the branch): one reader answers both
  const prFolder = usePullRequestFolder(thread.id, thread.cwd);
  const owner = JSON.stringify([thread.id, prFolder, version, completed?.id]);
  const [result, setResult] = useState<{ owner: string; pr: ThreadPullRequest | null } | null>(null);
  useEffect(() => {
    if (!open) return;
    let live = true;
    // the row's badge refreshes the PR each minute; the menu reuses that read rather than waiting on GitHub again
    readPullRequest(thread.id, prFolder, false, version).then(
      (pr) => {
        if (live) setResult({ owner, pr });
      },
      () => {
        if (live) setResult({ owner, pr: null });
      },
    );
    return () => {
      live = false;
    };
  }, [open, thread.id, prFolder, version, owner]);
  // until this opening's first read settles, the chat's last settled PR shows at once (the menu mounts on each opening);
  // once a read settled, a changed chat, folder, version or completed turn shows nothing until its own read does
  const pr = !result
    ? (readPullRequest.known(thread.id, prFolder, version) ?? readPullRequest.known(thread.id, folder, version) ?? null)
    : result.owner === owner
      ? result.pr
      : null;
  return (
    <Menu anchor={anchor} open={open} onClose={onClose} placement={placement} width={220}>
      <MenuLetters>
        {pr && (
          <LetterItem letter="G" onSelect={() => openLink(pr.url)}>
            Open PR
          </LetterItem>
        )}
        <SubMenu label={OPEN_IN.menu}>
          <MenuItem onSelect={() => openChat(thread.id, 'split')}>{OPEN_IN.split}</MenuItem>
          <MenuItem onSelect={() => openChat(thread.id, 'window')}>{OPEN_IN.window}</MenuItem>
          <MenuSeparator />
          <OpenInItems path={folder} machine={machine} />
        </SubMenu>
        <MenuSeparator />
        <LetterItem letter="P" onSelect={() => setState((s) => ({ pinned: { ...s.pinned, [thread.id]: !s.pinned[thread.id] } }))}>
          {pinned ? 'Unpin' : 'Pin'}
        </LetterItem>
        <LetterItem letter="U" onSelect={() => setState((s) => ({ unread: { ...s.unread, [thread.id]: true } }))}>
          Mark as unread
        </LetterItem>
        <LetterItem letter="R" onSelect={onRename}>
          Rename
        </LetterItem>
        <LetterItem letter="F" onSelect={() => forkThread(thread.id).catch(toastFailure("Couldn't fork the chat"))}>
          Fork
        </LetterItem>
        <MenuSeparator />
        <LetterItem letter="A" onSelect={() => archiveThread(thread.id).catch(toastFailure("Couldn't archive the chat"))}>
          Archive
        </LetterItem>
        <LetterItem
          letter="D"
          danger
          onSelect={() => {
            if (confirm(deleteChatQuestion(deleteMachineName(thread.id, machine, machinePending), hostAgentOf(thread.id))))
              deleteThread(thread.id).catch(toastFailure("Couldn't delete the chat"));
          }}
        >
          Delete
        </LetterItem>
      </MenuLetters>
    </Menu>
  );
}

/** Letter hints are visual; the accessible name remains the action, as for a submenu arrow. */
function LetterItem({ letter, ...props }: ComponentProps<typeof MenuItem> & { letter: string }) {
  return (
    <MenuItem
      {...props}
      right={
        <span className="menu-shortcut" aria-hidden="true">
          {letter}
        </span>
      }
    />
  );
}
