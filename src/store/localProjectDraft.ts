// Selecting a local project retires the execution settings owned by an earlier repository draft.
import { set } from './core';

/** An explicit project change retires execution settings owned by the previous repository. */
export function selectLocalProject(projectId: string | null, cwd: string | null = null) {
  set((state) => ({
    newChatProjectId: projectId,
    newChatCwd: cwd,
    ...(state.newChatRepositoryGroup && { newChatRepositoryGroup: undefined, newChatCloudEnv: null }),
  }));
}
