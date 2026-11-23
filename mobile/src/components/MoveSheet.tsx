// "Move to another computer": pick a machine, a folder on it, and whether the chat's changes go along; the Mac's words for a refusal show as they are.
import { useEffect, useRef, useState } from 'react';
import { Text } from 'react-native';
import { explain, type Owned } from '../remote/client';
import {
  type Folder,
  type FolderListing,
  type MoveTarget,
  moveChat,
  readFolders,
  readMoveProjects,
  type SavedProject,
} from '../remote/machineMove';
import type { Machine } from '../remote/machines';
import { type ChatAgent, cannotTake, moveRefusal } from '../remote/moveAgents';
import { useTheme } from '../theme';
import { BottomSheet } from './BottomSheet';
import { Group, GroupItem, GroupLabel } from './Grouped';
import { Button } from './ui';
import { typo } from '../typography';

type Step =
  | { kind: 'machine' }
  | { kind: 'folder'; machine: Machine }
  | { kind: 'project'; machine: Machine }
  | { kind: 'carry'; machine: Machine; target: MoveTarget; where: string };

/** What This Mac's row says when the Mac takes no project from a phone (an older Mac): the phone is not told a project's folder. */
export const BACK_TO_MAC = 'Move it back on your Mac.';

/** The folder above a listing's, unless it is one of the machine's roots (or the top): there is nothing above those to browse. */
function up(listing: FolderListing): string | null {
  if (listing.roots.includes(listing.path)) return null;
  const parent = listing.path.replace(/\/[^/]+\/?$/, '') || '/';
  return parent === listing.path ? null : parent;
}

export function MoveSheet({
  open,
  onClose,
  request,
  chatId,
  hostId,
  machines,
  agent,
  moved,
}: {
  open: boolean;
  onClose: () => void;
  request: Owned;
  chatId: string;
  /** where the chat runs now; none for this Mac */
  hostId?: string;
  machines: Machine[];
  /** the agent the chat runs on, so a machine that cannot take it says why before the press; none when the Mac did not name it */
  agent?: ChatAgent | null;
  /** the chat moved: the screen reads it again */
  moved: () => void;
}) {
  const theme = useTheme();
  const [step, setStep] = useState<Step>({ kind: 'machine' });
  const [listing, setListing] = useState<FolderListing | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // the saved projects a chat can move back into on this Mac; null while unread, and from a Mac that takes none
  const [projects, setProjects] = useState<SavedProject[] | null>(null);
  // the newest ask: a folder listing or a move that answers after the person went back, or closed the sheet, is dropped
  const asked = useRef(0);
  const here = hostId ?? 'local';
  // the projects the picker lists (the step is only reached once they were read)
  const saved = projects ?? [];
  // read when the sheet opens, and only for a chat that is somewhere else (This Mac is where it runs otherwise); a failed read leaves the row's line
  useEffect(() => {
    if (!open || here === 'local') return;
    let current = true;
    readMoveProjects(request)
      .then((read) => current && setProjects(read))
      .catch(() => current && setProjects(null));
    return () => {
      current = false;
    };
  }, [open, here, request]);

  const reset = () => {
    asked.current++;
    setStep({ kind: 'machine' });
    setListing(null);
    setError(null);
    setBusy(false);
  };
  const close = () => {
    reset();
    onClose();
  };
  async function browse(machine: Machine, path?: string) {
    const mine = ++asked.current;
    setStep({ kind: 'folder', machine });
    setError(null);
    setBusy(true);
    try {
      const read = await readFolders(request, machine.id, path);
      if (mine === asked.current) setListing(read);
    } catch (e) {
      if (mine === asked.current) setError(explain(e));
    } finally {
      if (mine === asked.current) setBusy(false);
    }
  }
  async function move(machine: Machine, target: MoveTarget, carry: 'code' | 'none') {
    const mine = ++asked.current;
    setError(null);
    setBusy(true);
    try {
      await moveChat(request, { chatId, carry, ...target });
      // the Mac moved the chat even if the sheet was closed meanwhile: the screen reads it again either way
      if (mine === asked.current) close();
      moved();
    } catch (e) {
      // a refusal the Host can name is said by the fact that holds, in this machine's name; any other failure keeps the Mac's own words
      if (mine === asked.current) setError(moveRefusal(e, machine.name, agent?.label) ?? explain(e));
    } finally {
      if (mine === asked.current) setBusy(false);
    }
  }
  const back =
    step.kind === 'machine'
      ? undefined
      : step.kind === 'folder' || step.kind === 'project'
        ? reset
        : () => {
            setError(null);
            setStep(
              step.target.hostId === 'local' ? { kind: 'project', machine: step.machine } : { kind: 'folder', machine: step.machine },
            );
          };
  const title =
    step.kind === 'machine'
      ? 'Move to another computer'
      : step.kind === 'carry'
        ? 'Take the changes?'
        : step.kind === 'project'
          ? 'Pick a project'
          : step.machine.name;
  return (
    <BottomSheet open={open} title={title} onClose={close} onBack={back}>
      {step.kind === 'machine' && (
        <Group>
          {machines.map((m) => {
            const same = m.id === here;
            const backToMac = m.id === 'local';
            // This Mac takes a saved project, where the Mac says it does; else it says to do it there
            const projectsHere = backToMac && !same && projects !== null;
            // a machine that reports it cannot take this chat's agent says why, and is not pressable
            const why = same || backToMac ? null : cannotTake(m, agent);
            return (
              <GroupItem
                key={m.id}
                title={m.name}
                detail={same ? 'This chat runs here.' : backToMac && !projectsHere ? BACK_TO_MAC : (why ?? m.line)}
                end={same ? 'check' : (backToMac && !projectsHere) || why ? 'none' : 'chevron'}
                onPress={
                  same || why || (backToMac && !projectsHere)
                    ? undefined
                    : () => (backToMac ? setStep({ kind: 'project', machine: m }) : void browse(m))
                }
              />
            );
          })}
        </Group>
      )}
      {step.kind === 'project' && (
        <>
          <Group>
            {saved.map((p) => (
              <GroupItem
                key={p.id}
                title={p.label}
                detail={p.branch ?? undefined}
                end="chevron"
                onPress={() =>
                  setStep({ kind: 'carry', machine: step.machine, target: { hostId: 'local', projectId: p.id }, where: p.label })
                }
              />
            ))}
          </Group>
          {!saved.length && <GroupLabel>No saved projects on this Mac.</GroupLabel>}
        </>
      )}
      {step.kind === 'folder' && (
        <>
          {!!listing && <GroupLabel>{listing.path}</GroupLabel>}
          {busy && !listing && <GroupLabel>Loading…</GroupLabel>}
          {!!listing && (
            <Group>
              {up(listing) && (
                <GroupItem title=".." detail="Up one folder" end="chevron" onPress={() => void browse(step.machine, up(listing)!)} />
              )}
              {listing.entries.map((f: Folder) => (
                <GroupItem
                  key={f.path}
                  title={f.name}
                  detail={f.git ? 'Repository' : undefined}
                  end="chevron"
                  onPress={() => void browse(step.machine, f.path)}
                />
              ))}
            </Group>
          )}
          {!!listing && listing.more && <GroupLabel>More folders are on the machine than the phone lists.</GroupLabel>}
          {!!listing && (
            <Button
              title="Use this folder"
              disabled={busy}
              onPress={() =>
                setStep({
                  kind: 'carry',
                  machine: step.machine,
                  target: { hostId: step.machine.id, folder: listing.path },
                  where: listing.path,
                })
              }
            />
          )}
        </>
      )}
      {step.kind === 'carry' && (
        <>
          <GroupLabel>{`${step.machine.name}: ${step.where}`}</GroupLabel>
          <Group>
            <GroupItem
              title="Take the changes along"
              detail="Uncommitted changes to tracked files"
              onPress={busy ? undefined : () => void move(step.machine, step.target, 'code')}
            />
            <GroupItem title="Leave the changes" onPress={busy ? undefined : () => void move(step.machine, step.target, 'none')} />
          </Group>
        </>
      )}
      {!!error && (
        <Text accessibilityRole="alert" style={{ ...typo.footnote, color: theme.bad, paddingHorizontal: 8, paddingTop: 10 }}>
          {error}
        </Text>
      )}
    </BottomSheet>
  );
}
