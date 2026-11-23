// The shared destination identity for the new-chat project picker and sidebar marker.
import { newChatGoal } from '../../store/projects';
import type { AppState } from '../../store/state';

/** Identifies a remote folder, a standalone local folder, or a saved project. */
export type HomeTarget = { kind: 'machine'; id: string; path: string } | { kind: 'folder'; path: string } | { kind: 'project'; id: string };

// Reuse the result on unrelated store writes. Resolving the default can walk the entire chat and project history.
const inputsOf = (s: AppState) => [
  s.newChatProjectId,
  s.newChatCwd,
  s.newChatHost,
  s.savedProjects,
  s.threadOrder,
  s.threads,
  s.chatProject,
  s.home,
];
let last: { inputs: unknown[]; target: HomeTarget | null } | null = null;

export function draftTarget(s: AppState): HomeTarget | null {
  const inputs = inputsOf(s);
  if (last?.inputs.every((input, i) => input === inputs[i])) return last.target;
  const goal = newChatGoal(s);
  const target: HomeTarget | null =
    goal?.kind === 'machine'
      ? { kind: 'machine', id: goal.pick.id, path: goal.pick.path }
      : goal?.kind === 'project'
        ? { kind: 'project', id: goal.project.id }
        : goal;
  last = { inputs, target };
  return target;
}

/** The sidebar marks the draft's destination only while the home page is open. */
export function homeTarget(s: AppState): HomeTarget | null {
  return s.route.name === 'home' ? draftTarget(s) : null;
}
