// The Changes pane's source for a folder on a machine: its Host reads the patch (git.diff) and does the commit and discard, and the pane's controls that need a copy of the folder on this Mac say why they are off, here and nowhere else.
import { useMemo } from 'react';
import type { Capability, ChangesCapabilities, ChangesSource } from './changesSource';
import { parseUnifiedDiff } from './diff';
import { folderNotice } from './hostFolders';
import { discardFailure, hostCommit, hostDiscard } from './hostWrite';
import { ignoring } from './ignored';
import { folderOnMachine, machineFolderKey } from './machineFolder';
import { native } from './native';
import { relPath } from './paths';

/** What the pane says under a patch the Host cut at its bound. */
const CUT = 'The patch is cut here; more changes are not shown.';
/** What the pane says under a turn whose changes the Host left some big new files out of. */
const largeFilesNote = (count: number): string =>
  count > 0 ? `${count === 1 ? '1 large untracked file is' : `${count} large untracked files are`} not shown.` : '';

/** What Last Turn says when the Host has no start of the turn to compare with; the other scopes still work. */
const BASELINE_GONE = "This turn's baseline is gone. Uncommitted shows what has changed now.";

const off = (reason: string): Capability => ({ on: false, reason });

/** The turns, newest first, a Last Turn read looks through for one that changed files (an answer-only turn changed none). */
const TURNS_LOOKED_AT = 5;

/** What the pane offers for a folder on `machineName`, each missing control with its reason; Last Turn needs a Host that takes the turns' trees, which a Host older than this app does not. */
export function machineCapabilities(machineName: string, stale = false): ChangesCapabilities {
  const here = folderOnMachine(machineName);
  return {
    lastTurn: stale ? off("Update the Host on that machine to see a turn's changes") : { on: true },
    openInEditor: off(here),
    reveal: off(here),
    attach: off(here),
    comments: off(`Comments are not built for a folder on ${machineName} yet`),
    // docs/host.md: a machine's folder is read when the pane asks, never on a timer
    poll: off(`Changes on ${machineName} are read when you ask, not on a timer`),
  };
}

/** The pane's source for `folder` on the machine `machine`. */
export function machineChangesSource(machine: { id: string; name: string; stale?: boolean }, folder: string): ChangesSource {
  const key = machineFolderKey(machine.id, folder);
  return {
    key,
    where: ` on ${machine.name}`,
    keyOf: (root) => machineFolderKey(machine.id, root),
    pathOf: relPath,
    read: async (scope, _fresh, live) => {
      let reply;
      try {
        reply = await native.host.gitDiff(machine.id, { path: folder, scope });
      } catch (error) {
        ignoring("read a machine's files")(error);
        return live() ? { kind: 'notice', text: 'Could not read that on the machine.' } : null;
      }
      if (!live()) return null;
      if (reply.error) return { kind: 'notice', text: folderNotice(reply.error), hostId: machine.id };
      const diff = reply.value;
      if (!diff.isRepo) return { kind: 'notRepo' };
      if (diff.unreadable) return { kind: 'notice', text: 'The machine could not read the changes.' };
      return {
        kind: 'files',
        root: folder,
        files: parseUnifiedDiff(diff.patch),
        ...(diff.truncated && { cut: CUT }),
        // an older Host does not say which files are in conflict: none are marked, as before
        conflicted: diff.conflicted ?? [],
      };
    },
    readTurn: async (turnIds, live) => {
      for (const turnId of turnIds.slice(0, TURNS_LOOKED_AT)) {
        let reply;
        try {
          reply = await native.host.gitTurnDiff(machine.id, { path: folder, turnId });
        } catch (error) {
          ignoring("read a turn's changes on a machine")(error);
          return live() ? { kind: 'notice', text: 'Could not read that on the machine.' } : null;
        }
        if (!live()) return null;
        if (reply.error) return { kind: 'notice', text: folderNotice(reply.error), hostId: machine.id };
        const turn = reply.value;
        if (!turn.isRepo) return { kind: 'notRepo' };
        // a turn the Host has no start of (lost with a Host that stopped under it, or never taken) is not looked past: the turn before it changed other files
        if (!turn.baseline) return { kind: 'notice', text: BASELINE_GONE };
        const files = parseUnifiedDiff(turn.patch);
        // big new files the Host left out of its snapshots are not in the patch: said, in one sentence under the files
        const note = [turn.truncated ? CUT : '', largeFilesNote(turn.skipped?.count ?? 0)].filter(Boolean).join(' ');
        // a turn that changed only such files is that turn's answer, not a reason to look at an earlier one
        if (files.length || turn.skipped) return { kind: 'files', root: folder, files, conflicted: [], ...(note && { cut: note }) };
      }
      // no turn changed a file
      return { kind: 'files', root: folder, files: [], conflicted: [] };
    },
    commit: (_root, message, files) => hostCommit(machine.id, folder, message, files),
    discard: (_root, file) => hostDiscard(machine.id, folder, file),
    discardFailure: (_file, result) => discardFailure(result),
    capabilities: machineCapabilities(machine.name, machine.stale),
  };
}

/** The same source for as long as the machine, its name and the folder are. */
export function useMachineChangesSource({ id, name, stale }: { id: string; name: string; stale?: boolean }, folder: string): ChangesSource {
  return useMemo(() => machineChangesSource({ id, name, stale }, folder), [id, name, stale, folder]);
}
