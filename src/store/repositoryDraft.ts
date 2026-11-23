// New-chat project and execution choices, scoped to the current repository draft.
import { get, set } from './core';
import type { AppState } from './state';
import { native, type CloudEnv } from '../lib/native';
import { cloudSidebarAccount } from '../lib/cloudSidebarAccount';
import { environmentRepository } from '../../shared/sidebarRepository.mjs';
import { pickNewChatHarness } from './chats';
import type { DraftDestination, RepositoryDraft } from '../../shared/model/repositorySidebar';
export type { DraftDestination, RepositoryDraft } from '../../shared/model/repositorySidebar';

export const chooseRepositoryLocation = 'Choose where to run this chat.';
export const chooseRepositoryEnvironment = 'Choose a cloud environment for this project.';

export function repositoryCloudMatches(repository: string, id: string, envs: readonly CloudEnv[] | undefined) {
  return !!envs?.some((env) => env?.id === id && environmentRepository(env) === repository);
}

export function repositoryDraftProblem(state: AppState, cloudEnv: { id: string } | null) {
  const draft = state.newChatRepositoryGroup;
  if (draft?.needsLocation) return chooseRepositoryLocation;
  if (
    draft &&
    state.newChatCloudEnv &&
    (!cloudEnv ||
      state.cloudSidebar?.account !== cloudSidebarAccount(state) ||
      !repositoryCloudMatches(draft.repository, cloudEnv.id, state.cloudSidebar.environments))
  )
    return chooseRepositoryEnvironment;
  if (draft && !state.newChatHost && !state.newChatCloudEnv) {
    const location = draft.destinations.find((destination) => destination.kind === 'local');
    if (!location || state.newChatProjectId !== location.projectId) return chooseRepositoryLocation;
    const path = location.projectId
      ? state.savedProjects.find((project) => project.id === location.projectId)?.roots[0]?.path
      : state.newChatCwd;
    if (path !== location.path) return chooseRepositoryLocation;
  }
  return null;
}

/** The cache can describe offline checkouts. Sending requires a fresh answer from the same registration. */
export async function verifyRepositoryMachine(draft: RepositoryDraft, host: { id: string; path: string }) {
  const choice = draft.destinations.find(
    (d): d is Extract<DraftDestination, { kind: 'machine' }> => d.kind === 'machine' && d.id === host.id && d.path === host.path,
  );
  if (!choice) return null;
  const scope = choice.scope ?? '';
  const result = await native.host.sidebarRepository(host.id, { path: host.path, fresh: true, expectedHostKey: scope });
  return result.value === draft.repository && get().newChatRepositoryGroup === draft ? { scope } : null;
}

export function selectRepositoryDestination(draft: RepositoryDraft, destination: DraftDestination | undefined) {
  const local = draft.destinations.find((location) => location.kind === 'local');
  const project = destination?.kind === 'local' ? destination : local;
  if (destination?.kind === 'cloud') pickNewChatHarness('codex');
  set({
    newChatRepositoryGroup: { ...draft, needsLocation: !destination },
    newChatProjectId: destination?.kind === 'machine' ? null : project ? project.projectId : 'none',
    newChatCwd: destination?.kind === 'machine' || project?.projectId ? null : (project?.path ?? null),
    newChatCloudEnv: destination?.kind === 'cloud' ? { id: destination.id, label: destination.label } : null,
    newChatHost:
      destination?.kind === 'machine'
        ? {
            id: destination.id,
            name: destination.name,
            path: destination.path,
            before: { projectId: local ? local.projectId : 'none', cwd: local?.projectId ? null : (local?.path ?? null) },
          }
        : null,
  });
}

/** The machine pick ends: the new chat targets again what it did before (the default when that is not known). */
export function dropNewChatHost(pick: NonNullable<AppState['newChatHost']>) {
  const draft = get().newChatRepositoryGroup;
  if (draft) {
    const destinations = draft.destinations.filter((d) => d.kind !== 'machine' || d.id !== pick.id);
    return selectRepositoryDestination({ ...draft, destinations }, undefined);
  }
  set({ newChatHost: null, newChatProjectId: pick.before?.projectId ?? null, newChatCwd: pick.before?.cwd ?? null });
}

export function clearCloudDestination() {
  const draft = get().newChatRepositoryGroup;
  if (!draft) return set({ newChatCloudEnv: null });
  selectRepositoryDestination(
    draft,
    draft.destinations.find((location) => location.kind === 'local'),
  );
}

/** A restored repository draft asks for a location again before any execution. */
export function restoreRepositoryDraft(draft: RepositoryDraft | undefined): RepositoryDraft | undefined {
  if (!draft || typeof draft.repository !== 'string' || typeof draft.name !== 'string' || !Array.isArray(draft.destinations)) return;
  return { ...draft, needsLocation: true };
}
