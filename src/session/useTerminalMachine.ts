// The machine the bottom terminal opens a shell on: the focused chat's, else the machine the new-chat draft picked (the composer's machine chip), else none (this Mac).
import { useStore } from '../store/core';
import { newChatHostPick } from '../store/projects';
import { terminalMachineOf, type ShellMachine } from '../lib/machineShell';

/** @param focusedId the chat in front, null on the new-chat screen @param chatMachine that chat's machine, null for this Mac @param chatFolder the chat's folder there */
export function useTerminalMachine(
  focusedId: string | null,
  chatMachine: { id: string; name: string } | null,
  chatFolder: string | undefined,
): ShellMachine | null {
  const draft = useStore((s) => (focusedId ? null : newChatHostPick(s)));
  return terminalMachineOf(focusedId !== null, chatMachine, chatFolder, draft);
}
