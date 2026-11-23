// The new-chat context bar's workspace chip: a project's existing worktrees that were brought over in place (Conductor workspaces), to start the chat in one as it is instead of in a new worktree.

import { useState } from 'react';
import { useEffectOn } from '../../lib/effects';
import { useStore, set as setState } from '../../store/core';
import { native } from '../../lib/native';
import { ignoring } from '../../lib/ignored';
import { Menu, MenuItem, MenuLabel, useAnchor } from '../ui/Popover';
import { FolderGit2 } from 'lucide-react';

type Workspace = { path: string; name: string; branch: string | null };

/** The workspace this draft picked for the folder `root`, or null. */
export const pickedWorkspace = (s: { newChatWorkspace: { root: string; path: string; name: string } | null }, root: string) =>
  s.newChatWorkspace?.root === root ? s.newChatWorkspace : null;

/**
 * Nothing for a folder with no workspaces brought over and no pick. Else a chip that says where the chat will run: "New worktree or
 * this folder" (the branch and Worktree controls beside it decide which), or the picked workspace, where the chat runs on
 * the branch that workspace has and those controls go away. The list is read when the folder changes and when the menu
 * opens; a pick whose workspace is gone by then is dropped.
 */
export function WorkspaceChip({ path }: { path: string }) {
  const picked = useStore((s) => pickedWorkspace(s, path));
  const menu = useAnchor<HTMLButtonElement>();
  const [list, setList] = useState<{ root: string; spaces: Workspace[] } | null>(null);
  useEffectOn([path, menu.open], () => {
    let current = true;
    native.git.worktreeAdopted(path).then((spaces) => {
      // git could not say: what was known stays, and so does a pick (the chat start checks its folder itself)
      if (!current || !spaces) return;
      setList({ root: path, spaces });
      // a pick whose workspace is gone (removed in Conductor, or from disk) would start a chat in no folder
      setState((s) => {
        const mine = pickedWorkspace(s, path);
        return mine && !spaces.some((w) => w.path === mine.path) ? { newChatWorkspace: null } : {};
      });
    }, ignoring('list the workspaces brought over for a new chat'));
    return () => {
      current = false;
    };
  });
  // another folder's list is not this one's
  const spaces = list?.root === path ? list.spaces : [];
  // a pick always shows, also before its folder's list is known: it decides where the chat runs
  if (!spaces.length && !picked) return null;
  return (
    <>
      <button
        ref={menu.ref}
        className={`ctx-btn ${menu.open ? 'active' : ''}`}
        onClick={menu.toggle}
        aria-label={picked ? `Workspace: ${picked.name}` : 'Workspace'}
        title="Run this chat in a workspace brought over from Conductor"
      >
        <FolderGit2 size={15} strokeWidth={1.7} />
        <span>{picked ? picked.name : 'Workspaces'}</span>
      </button>
      <Menu anchor={menu.anchor} open={menu.open} onClose={menu.close} placement="top-start" width={282}>
        <MenuLabel>Run in</MenuLabel>
        <MenuItem checked={!picked} onSelect={() => setState({ newChatWorkspace: null })}>
          New worktree or this folder
        </MenuItem>
        {spaces.map((w) => (
          <MenuItem
            key={w.path}
            title={w.path}
            description={w.branch ?? 'No branch checked out'}
            checked={picked?.path === w.path}
            onSelect={() => setState({ newChatWorkspace: { root: path, path: w.path, name: w.name } })}
          >
            {w.name}
          </MenuItem>
        ))}
      </Menu>
    </>
  );
}
