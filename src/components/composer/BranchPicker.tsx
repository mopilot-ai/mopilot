// The new-chat context bar's branch + worktree chip and its branch picker (as in Claude Code's desktop app), where `#12` or a link picks a pull request's branch, or an issue for the chat to start from.

import { useEffect, useRef, useState } from 'react';
import { useStore, set as setState } from '../../store/core';
import { newChatWorktreeOn, setNewChatWorktree } from '../../store/chats';
import type { BranchList } from '../../lib/native';
import { useBranchList } from '../../lib/branchList';
import { machineFolderOf } from '../../lib/machineFolder';
import { worktreeUnsupported } from '../../../shared/worktreeSupport.mjs';
import { Popover, useAnchor } from '../ui/Popover';
import { Check, GitBranch, Search } from '../ui/icons';
import { MenuRow, useListbox } from '../ui/MenuList';
import { useLinearConnected, useStartLookup, type StartLookup } from '../../lib/startSourceLookup';
import { startRef } from '../../../shared/startRef.mjs';

/** Rows drawn at once; a repo can have hundreds of branches, so the rest are reached by searching. */
const SHOWN = 200;

/** The branch a new chat starts on: the picked one, else origin's default with a worktree, else the checked-out one. */
export function branchShown(list: BranchList, picked: string | null, worktree: boolean): string | null {
  return picked ?? (worktree ? (list.default ?? list.current) : list.current);
}

/**
 * The context bar's branch + worktree chip (as in Claude Code's desktop app): the branch the chat starts on,
 * which opens the branch picker, and the worktree switch. A worktree starts from the branch; without one the
 * folder is switched to it when the chat starts. `path` is a folder of this Mac, or a machine's by its folder key: the machine's Host is where its branches are read and the worktree or switch is made (src/store/machineStart.ts). Nothing is drawn until the folder's branches load, nor outside a git
 * repo, where there is nothing to choose; in a repo with no commits the switch is off and says why. Either way the
 * chat runs in the folder itself.
 */
export function WorktreeChip({ path }: { path: string }) {
  const wanted = useStore(newChatWorktreeOn);
  const pick = useStore((s) => (s.newChatBranch?.path === path ? s.newChatBranch : null));
  const picked = pick?.branch ?? null;
  const pr = pick?.pullRequest;
  const issue = pick?.issue;
  const linear = pick?.linear;
  const menu = useAnchor<HTMLButtonElement>();
  // a folder on a machine (its key): its branches come from that machine, and a pull request or issue is looked up on this Mac's own checkout of it only
  const onMachine = machineFolderOf(path) !== null;
  // reloaded when the menu opens or closes, so branches made since show up
  const list = useBranchList(path, true, menu.open);
  // not known yet, or not a repo (or git can't list it): the chip and its switch would only flash or sit greyed out
  if (!list) return null;
  const unsupported = worktreeUnsupported(list);
  const worktree = wanted && !unsupported;
  const shown = branchShown(list, picked, worktree) ?? 'HEAD';
  const from = pr ?? issue;
  const label = linear ? `${linear.key} ${shown}` : from ? `#${from.number} ${shown}` : shown;

  return (
    <div className="ctx-wt">
      <button
        ref={menu.ref}
        className={`ctx-wt-branch ${menu.open ? 'active' : ''}`}
        onClick={menu.toggle}
        aria-label={`Branch: ${label}`}
        title={
          pr
            ? `Pull request #${pr.number}: ${pr.title}`
            : issue
              ? `Issue #${issue.number}: ${issue.title}. Your first message carries its text.`
              : linear
                ? `Linear issue ${linear.key}: ${linear.title}. Your first message carries its text.`
                : worktree
                  ? 'Branch the worktree starts from'
                  : 'Branch to work on'
        }
      >
        <GitBranch size={15} strokeWidth={1.7} />
        <span>{label}</span>
      </button>
      <label
        className={`ctx-check ${unsupported ? 'disabled' : ''}`}
        title={unsupported ? `Worktree unavailable: ${unsupported}` : 'Run this chat in an isolated git worktree'}
      >
        <input type="checkbox" checked={worktree} disabled={!!unsupported} onChange={(e) => setNewChatWorktree(e.target.checked)} />
        <span className="checkbox">{worktree && <Check size={11} strokeWidth={3} />}</span>
        <span>Worktree</span>
      </label>
      <BranchMenu
        anchor={menu.anchor}
        open={menu.open}
        onClose={menu.close}
        branches={list.branches}
        selected={from ? null : shown}
        onPick={(branch) => {
          setState({ newChatBranch: { path, branch } });
          menu.close();
        }}
        path={onMachine ? null : path}
        onPickSource={
          onMachine
            ? undefined
            : (found) => {
                // an issue keeps the branch picked before it (none: the default, which follows the Worktree switch), since the
                // chat's text carries the issue; a pull request works on its own head
                if ('kind' in found && found.kind === 'linear')
                  setState({
                    newChatBranch: { path, branch: picked, linear: { key: found.key, title: found.title, branch: found.branch } },
                  });
                else if ('kind' in found)
                  setState({ newChatBranch: { path, branch: picked, issue: { number: found.number, title: found.title } } });
                else
                  setState({
                    newChatBranch: {
                      path,
                      branch: found.head,
                      pullRequest: { number: found.number, title: found.title, fork: found.fork, own: found.own },
                    },
                  });
                menu.close();
              }
        }
      />
    </div>
  );
}

type Found = Extract<StartLookup, { state: 'found' }>['found'];

/** What the menu says about a pull request or issue being looked up, or that the lookup failed; null once it is found. */
const lookupText = (lookup: StartLookup) =>
  lookup.state === 'looking' ? `Looking up ${lookup.label}…` : lookup.state === 'failed' ? lookup.error : null;

/** What the found row says under its title: where a pull request's branch goes, or what starting from an issue does. */
const foundDesc = (found: Found) =>
  'kind' in found && found.kind === 'linear'
    ? `Linear issue · a new chat that starts with its text${found.branch ? `, on ${found.branch} with a worktree` : ''}${found.done ? ` · ${found.state.toLowerCase()}` : ''}`
    : ('kind' in found
        ? `Issue · a new chat that starts with its text`
        : found.own
          ? `${found.head} into ${found.base}`
          : `${found.head}${found.fork ? ' from a fork' : ''}, as pr/${found.number} into ${found.base}`) +
      (found.state === 'OPEN' ? '' : ` · ${found.state.toLowerCase()}`);

/**
 * The branch list with the search field under it; arrows and Enter pick without the mouse. With `onPickSource`, search
 * text naming a pull request or issue (`#12`, or either's link) shows it in place of the branches.
 */
export function BranchMenu({
  anchor,
  open,
  onClose,
  branches,
  selected,
  onPick,
  path = null,
  onPickSource,
}: {
  anchor: HTMLElement | null;
  open: boolean;
  onClose: () => void;
  branches: string[];
  selected: string | null;
  onPick: (branch: string) => void;
  path?: string | null;
  onPickSource?: (found: Found) => void;
}) {
  const [q, setQ] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  const linear = useLinearConnected(open && !!onPickSource);
  const lookup = useStartLookup(open && onPickSource ? path : null, q, linear);
  // a Linear key could be a branch's name too: its branches stay listed under it
  const linearAsked = linear && startRef(q)?.kind === 'linear';
  const found = lookup.state === 'found' ? lookup.found : null;
  const needle = q.trim().toLowerCase();
  const matches =
    lookup.state !== 'none' && !linearAsked ? [] : needle ? branches.filter((b) => b.toLowerCase().includes(needle)) : branches;
  const list = matches.slice(0, SHOWN);
  // the found pull request or issue is the first row, then any branches listed under it
  const first = found ? 1 : 0;
  const box = useListbox(first + list.length, (i) => (found && i === 0 ? onPickSource?.(found) : onPick(list[i - first])));
  const { setIndex } = box;
  // the found row arriving moves the branches down one: the highlight starts again at the top, on it
  const foundKey = found ? ('kind' in found && found.kind === 'linear' ? found.key : `#${found.number}`) : null;
  useEffect(() => {
    if (foundKey) setIndex(0);
  }, [foundKey, setIndex]);
  useEffect(() => {
    if (!open) return;
    setQ('');
    setIndex(0);
    requestAnimationFrame(() => inputRef.current?.focus());
  }, [open, setIndex]);

  return (
    <Popover anchor={anchor} open={open} onClose={onClose} placement="top-start">
      <div className="menu branch-menu">
        <div className="menu-scroll" id={box.listId} role="listbox" aria-label="Branches">
          {found && (
            <MenuRow className={box.index === 0 ? 'kbd-active' : ''} {...box.option(0)} onClick={() => onPickSource?.(found)}>
              <span className="menu-label">
                <span className="menu-title">
                  {'kind' in found && found.kind === 'linear' ? found.key : `#${found.number}`} {found.title}
                </span>
                <span className="menu-desc">{foundDesc(found)}</span>
              </span>
            </MenuRow>
          )}
          {lookupText(lookup) && <div className="menu-empty">{lookupText(lookup)}</div>}
          {list.map((b, i) => (
            <MenuRow key={b} className={i + first === box.index ? 'kbd-active' : ''} {...box.option(i + first)} onClick={() => onPick(b)}>
              <span className="menu-label">
                <span className="menu-title">{b}</span>
              </span>
              <span className="menu-check">{b === selected ? <Check size={15} strokeWidth={2} /> : null}</span>
            </MenuRow>
          ))}
          {matches.length > list.length && <div className="menu-empty">{matches.length - list.length} more · search to narrow</div>}
          {lookup.state === 'none' && list.length === 0 && <div className="menu-empty">No branches</div>}
        </div>
        <div className="menu-sep" />
        <div className="menu-search">
          <Search size={15} strokeWidth={1.7} />
          <input
            ref={inputRef}
            placeholder={onPickSource ? 'Search branches, or #12 for a pull request or issue…' : 'Search branches…'}
            aria-label="Search branches"
            value={q}
            onChange={(e) => {
              setQ(e.target.value);
              setIndex(0);
            }}
            {...box.field}
          />
        </div>
      </div>
    </Popover>
  );
}
