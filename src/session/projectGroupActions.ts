// Removing a combined project group retires each saved alias in order, stopping on a visible failure.
import { deleteProject } from '../store/projects';

export async function deleteProjectGroup(id: string, aliases: string[] = []) {
  for (const projectId of new Set([id, ...aliases])) await deleteProject(projectId);
}
