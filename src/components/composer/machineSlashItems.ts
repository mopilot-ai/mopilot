// What a machine's agent lists, as the rows of the composer's `/` menu (#4915): a command or skill row inserts the text the agent takes for it, and a menu the machine cannot fill says why in one row. The same rows for a chat on the machine and for the new chat it is picked for.
import { useMachineCommands, type MachineCommands } from '../../session/useMachineCommands';
import type { SlashItem } from './ComposerPopups';

/** @param m what the machine lists @param put puts text in the message box (the composer's own `putCommand`) @param taken the names a menu already has, which a row of the machine does not repeat */
export function machineSlashItems(m: MachineCommands, put: (text: string) => void, taken: ReadonlySet<string> = new Set()): SlashItem[] {
  const { answer, machine } = m;
  const say = (id: string, desc: string): SlashItem[] => [{ id: `machine-${id}`, title: 'Commands', desc, disabled: desc }];
  if (!answer || answer.state === 'loading') return say('loading', `Reading ${machine.name}…`);
  if (answer.state === 'outdated') return say('outdated', `Update Host on ${machine.name} to list its commands.`);
  if (answer.state === 'unavailable') return say('unavailable', answer.notice);
  return answer.commands
    .filter((c) => !taken.has(c.name))
    .map(
      (c): SlashItem => ({
        id: `machine:${c.name}`,
        title: c.insert.startsWith('/') ? `/${c.name}` : c.name,
        desc: c.hint ? `${c.description} ${c.hint}`.trim() : c.description,
        scope: `on ${machine.name}`,
        skill: c.kind === 'skill',
        run: () => put(c.insert),
      }),
    );
}

/**
 * The rows of the `/` menu: `base` (the composer's own) for a chat on this Mac, and for a chat on a machine, or the new chat a machine is picked for, what the agent there lists: after the rows of a chat of a basic agent, and instead of the rows of this Mac's own for one of Claude Code or Codex. Without a list from the machine, the basic agent's menu keeps its row that says local skills are unavailable.
 * @param open whether the menu is open: the machine is asked only then
 * @param basic whether the chat runs a basic agent (an ACP one, or Claude Code or Codex as a machine runs them)
 * @param attachmentOff why a local skill cannot be attached here, or null
 */
export function useMachineMenu(
  threadId: string | null,
  open: boolean,
  put: (text: string) => void,
  base: SlashItem[],
  basic: boolean,
  attachmentOff: string | null,
): SlashItem[] {
  const machine = useMachineCommands(threadId, open);
  // an agent the machine cannot list (an ACP one, or a Host that had nothing yet): a chat keeps its own menu, with the agent's commands once its session pushed them; a new chat says so rather than showing this Mac's rows
  const unlisted = !!machine && machine.answer?.state === 'ready' && !machine.answer.listed;
  if (!machine || (unlisted && basic))
    return basic && attachmentOff
      ? [...base, { id: 'skills-unavailable', title: 'Skills', desc: attachmentOff, disabled: attachmentOff, skill: true }]
      : base;
  if (unlisted)
    return [{ id: 'machine-unlisted', title: 'Commands', desc: 'No commands listed yet.', disabled: 'No commands listed yet.' }];
  // beside a basic agent's own rows a name is not listed twice; instead of this Mac's rows (a new chat of Claude Code or Codex) every row of the machine is listed
  return basic
    ? [...base, ...machineSlashItems(machine, put, new Set(base.map((i) => i.title.replace(/^\//, ''))))]
    : machineSlashItems(machine, put);
}
