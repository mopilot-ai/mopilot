// Strips around the composer: the new-chat context bar (project, where it runs, branch and worktree), the live voice bar and the full-access warning.

import { useEffect, useState } from 'react';
import { useStore, setPrefs, set as setState } from '../../store/core';
import { newChatFolderKey, newChatHostPick, newChatTarget } from '../../store/projects';
import { newChatKind } from '../../store/chats';
import { useChatPermission } from '../../session/useComposerHarness';
import { useChatMachine } from '../../lib/chatMachine';
import { useHostMachines } from '../../lib/hostMachines';
import { cloudSidebarAccount } from '../../lib/cloudSidebarAccount';
import { repositoryCloudMatches, selectRepositoryDestination, type RepositoryDraft } from '../../store/repositoryDraft';
import { machineFolderOf } from '../../lib/machineFolder';
import { hostFamilyOfHarness } from '../../../shared/host/chatIds.mjs';
import { useHostPermission } from './useHostPermission';
import { ProjectMenu } from './ProjectMenu';
import { WorktreeChip } from './BranchPicker';
import { WorkspaceChip, pickedWorkspace } from './WorkspaceChip';
import { WorktreeHint } from './WorktreeHint';
import { fullAccessBannerText, permissionLearnMore } from '../../harness/permissionsMenu';
import { useCap } from '../../store/session/useCaps';
import type { HarnessId } from '../../harness/types';
import { useHostAccess } from '../../lib/host';
import { basename } from '../../lib/paths';
import { openLink } from '../../session/open';
import { MANAGE_ENVIRONMENTS, RunOnChip, useCloudEnvs } from './RunOnChip';
import { useVoice, toggleMute, dismissVoiceError } from '../../session/voice';
import { Menu, MenuItem, MenuSeparator, MenuLabel, Tooltip, useAnchor, SubMenu } from '../ui/Popover';
import { Mic, MicOff, AlertCircle, X, Folder, Laptop, Check, Cloud, ExternalLink } from '../ui/icons';
import { WebLink } from '../ui/WebLink';

/* ------------------------------------------------------------------ */
/* Context bar (new-chat only): project, environment, branch + worktree */
/* ------------------------------------------------------------------ */
/**
 * The folder a new-chat draft's Worktree switch is for: its project's or picked folder on this Mac, or a picked folder on a machine (by its folder key,
 * which the branch list reads through that machine's Host); none for a chat outside a project or one that runs in a cloud environment (`cloudCap`:
 * the draft's harness has one), which have no switch. The context bar and the / menu both read it, so they agree.
 */
export function useDraftWorktreeFolder(cloudCap: boolean): string | null {
  return useStore((s) => (cloudCap && s.newChatCloudEnv ? null : newChatFolderKey(s)));
}

export function ContextBar() {
  useStore((s) => s.newChatProjectId);
  useStore((s) => s.savedProjects);
  const kind = useStore((s) => newChatKind(s));
  const cloudCap = useCap(null, 'cloud', { kind }).state === 'native';
  const cloudEnv = useStore((s) => (cloudCap ? s.newChatCloudEnv : null));
  useStore((s) => s.newChatCwd);
  // a machine picked for the chat: the Run on chip names the machine, so the project chip names only the folder on it
  const hostPick = useStore((s) => newChatHostPick(s));
  const repositoryDraft = useStore((s) => s.newChatRepositoryGroup);
  const project = repositoryDraft ?? newChatTarget();
  const projectLabel =
    repositoryDraft?.name ??
    (hostPick ? (hostPick.path ? basename(hostPick.path) : 'Choose a folder') : (project?.name ?? 'Work in a project'));
  const hostAccess = useHostAccess();
  const wtFolder = useDraftWorktreeFolder(cloudCap);
  // a machine's folder has no other chats of this Mac running in it and no workspaces of other tools: those two are for this Mac's folders
  const here = wtFolder && !machineFolderOf(wtFolder) ? wtFolder : null;
  // a chat in a picked workspace runs on that workspace's branch: there is no branch or worktree to choose
  const inWorkspace = useStore((s) => !!wtFolder && !!pickedWorkspace(s, wtFolder));
  const proj = useAnchor();
  const env = useAnchor();
  const { envs, error: envErr } = useCloudEnvs(!repositoryDraft && env.open);

  return (
    <>
      {here && !inWorkspace && <WorktreeHint path={here} />}
      <div className="ctxbar">
        <Tooltip label={project ? `Change project: ${project.name}` : 'Work in a project'}>
          <button
            ref={proj.ref}
            className={`ctx-btn ${proj.open ? 'active' : ''}`}
            onClick={proj.toggle}
            aria-label={project ? `Change project: ${project.name}` : 'Work in a project'}
          >
            <Folder size={15} strokeWidth={1.7} />
            <span>{projectLabel}</span>
          </button>
        </Tooltip>
        {/* with Host, the one place the chat picks where it runs (machines, and Codex Cloud when its agent has it); without, Work in picks this computer or Codex Cloud */}
        {repositoryDraft ? (
          <RepositoryLocationChip draft={repositoryDraft} cloudLabel={cloudEnv?.label} machineName={hostPick?.name} />
        ) : hostAccess ? (
          <RunOnChip cloudCap={cloudCap} />
        ) : (
          cloudCap && (
            <button ref={env.ref} className={`ctx-btn ${env.open ? 'active' : ''}`} onClick={env.toggle} aria-label="Work in">
              {cloudEnv ? <Cloud size={15} strokeWidth={1.7} /> : <Laptop size={15} strokeWidth={1.7} />}
              <span>{cloudEnv ? cloudEnv.label : 'This computer'}</span>
            </button>
          )
        )}
        {here && <WorkspaceChip path={here} />}
        {wtFolder && !inWorkspace && <WorktreeChip path={wtFolder} />}
        <div className="ctx-spacer" />
        <ProjectMenu anchor={proj.anchor} open={proj.open} onClose={proj.close} placement="top-start" />
        <Menu anchor={env.anchor} open={env.open} onClose={env.close} placement="top-start" width={282}>
          <MenuLabel>Work in</MenuLabel>
          <MenuItem icon={<Laptop size={16} strokeWidth={1.7} />} checked={!cloudEnv} onSelect={() => setState({ newChatCloudEnv: null })}>
            This computer
          </MenuItem>
          <SubMenu icon={<Cloud size={16} strokeWidth={1.7} />} label="Cloud" hint={cloudEnv ? <Check size={14} /> : undefined}>
            {!envs && <MenuLabel>Loading environments…</MenuLabel>}
            {envs?.map((e) => (
              <MenuItem
                key={e.id}
                checked={cloudEnv?.id === e.id}
                onSelect={() => setState({ newChatHost: null, newChatCloudEnv: { id: e.id, label: e.label } })}
              >
                {e.label}
              </MenuItem>
            ))}
            {envs && envs.length === 0 && <MenuLabel>{envErr ?? 'No cloud environments'}</MenuLabel>}
            <MenuSeparator />
            <MenuItem icon={<ExternalLink size={14} />} onSelect={() => openLink(MANAGE_ENVIRONMENTS)}>
              Manage environments
            </MenuItem>
          </SubMenu>
        </Menu>
      </div>
    </>
  );
}

function RepositoryLocationChip({ draft, cloudLabel, machineName }: { draft: RepositoryDraft; cloudLabel?: string; machineName?: string }) {
  const menu = useAnchor();
  const { machines } = useHostMachines();
  const environments = useStore((s) => (s.cloudSidebar?.account === cloudSidebarAccount(s) ? s.cloudSidebar.environments : undefined));
  useEffect(() => {
    if (draft.needsLocation) menu.anchor?.focus();
  }, [draft.needsLocation, menu.anchor]);
  return (
    <>
      <button ref={menu.ref} className={`ctx-btn ${menu.open ? 'active' : ''}`} onClick={menu.toggle} aria-label="Work in">
        {cloudLabel ? <Cloud size={15} strokeWidth={1.7} /> : <Laptop size={15} strokeWidth={1.7} />}
        <span>{draft.needsLocation ? 'Choose where to run' : (cloudLabel ?? machineName ?? 'This computer')}</span>
      </button>
      <Menu anchor={menu.anchor} open={menu.open} onClose={menu.close} placement="top-start" width={282}>
        <MenuLabel>Work in</MenuLabel>
        {draft.destinations.map((destination) => (
          <MenuItem
            key={JSON.stringify(destination)}
            disabled={
              destination.kind === 'cloud'
                ? !repositoryCloudMatches(draft.repository, destination.id, environments)
                : destination.kind === 'machine' &&
                  !machines.some(
                    (machine) =>
                      machine.id === destination.id && machine.status === 'online' && machine.repositoryScope === destination.scope,
                  )
            }
            hint={destination.kind === 'machine' ? destination.path : undefined}
            icon={destination.kind === 'cloud' ? <Cloud size={15} /> : <Laptop size={15} />}
            onSelect={() => selectRepositoryDestination(draft, destination)}
          >
            {destination.kind === 'local' ? 'This computer' : destination.kind === 'cloud' ? destination.label : destination.name}
          </MenuItem>
        ))}
      </Menu>
    </>
  );
}

/** The voice strip's fixed bars, left to right: each scales the input level by its gain. */
const VOICE_BARS = [
  { id: 'outer-left', gain: 0.5 },
  { id: 'inner-left', gain: 0.8 },
  { id: 'center', gain: 1 },
  { id: 'inner-right', gain: 0.8 },
  { id: 'outer-right', gain: 0.5 },
];

/** Live voice-mode strip shown inside the composer while a realtime session runs. */
export function VoiceBar() {
  const { phase, muted, caption, level, error } = useVoice();
  const status =
    phase === 'connecting'
      ? 'Connecting…'
      : phase === 'error'
        ? (error ?? 'Voice unavailable')
        : muted
          ? 'Muted'
          : phase === 'speaking'
            ? 'Speaking'
            : 'Listening';
  return (
    <div className={`voice-bar ${phase}`}>
      <div className="voice-wave" aria-hidden>
        {VOICE_BARS.map(({ id, gain: b }) => (
          <i
            key={id}
            style={{
              transform: `scaleY(${phase === 'connecting' || muted ? 0.25 : Math.max(0.25, Math.min(1, level * 2.2 * b + (phase === 'speaking' ? 0.35 * b : 0)))})`,
            }}
          />
        ))}
      </div>
      <div className="voice-text">
        <div className="voice-status">{status}</div>
        {caption && phase !== 'error' && <div className={`voice-caption ${caption.role}`}>{caption.text}</div>}
      </div>
      {phase === 'error' ? (
        <>
          <button className="btn-pill" onClick={dismissVoiceError}>
            Dismiss
          </button>
        </>
      ) : (
        <Tooltip label={muted ? 'Unmute' : 'Mute'}>
          <button className={`composer-icon-btn ${muted ? 'active' : ''}`} onClick={toggleMute} aria-label={muted ? 'Unmute' : 'Mute'}>
            {muted ? <MicOff size={16} strokeWidth={1.8} /> : <Mic size={16} strokeWidth={1.8} />}
          </button>
        </Tooltip>
      )}
    </div>
  );
}

/** Warning above the composer while "Full access" is selected, as in the official app. */
let fullAccessClosedThisSession = false;
/** A chat on this Mac has a first-tier `harness`; one on a machine only the `basic` name of its Host agent, and its mode is the one picked for that machine. */
export function FullAccessBanner({
  harness,
  basic,
  threadId,
}: {
  harness: HarnessId | null;
  basic: string | null;
  threadId: string | null;
}) {
  if (harness) return <FullAccessWarning harness={harness} threadId={threadId} />;
  return threadId && basic ? <HostFullAccessBanner threadId={threadId} basic={basic} /> : null;
}

function HostFullAccessBanner({ threadId, basic }: { threadId: string; basic: string }) {
  const { machine } = useChatMachine(threadId);
  const family = hostFamilyOfHarness(basic);
  const mode = useHostPermission(threadId, family ?? 'claude', machine?.id ?? '');
  return machine && family ? <FullAccessWarning harness={family} threadId={threadId} hostMode={mode} /> : null;
}

/** `hostMode` is a machine chat's mode (its Host sets it, not this Mac's session); then the banner follows it. */
function FullAccessWarning({ harness, threadId, hostMode }: { harness: HarnessId; threadId: string | null; hostMode?: string }) {
  const own = useChatPermission(threadId);
  const mode = hostMode ?? own;
  const hidden = useStore((s) => s.prefs.hideFullAccessBanner);
  const [closed, setClosed] = useState(fullAccessClosedThisSession);
  if (mode !== 'full-access' || hidden || closed) return null;
  return (
    <div className="fa-banner">
      <AlertCircle size={16} strokeWidth={1.8} className="fa-icon" />
      <div className="fa-text">
        <div className="fa-title">Full access is on</div>
        {fullAccessBannerText(harness)} <WebLink href={permissionLearnMore(harness)}>Learn more</WebLink> about elevated risks.
      </div>
      <span className="fa-sep" />
      <button className="fa-dont" onClick={() => setPrefs({ hideFullAccessBanner: true })}>
        Don’t show again
      </button>
      <button
        className="icon-btn xs"
        aria-label="Dismiss"
        onClick={() => {
          fullAccessClosedThisSession = true;
          setClosed(true);
        }}
      >
        <X size={13} />
      </button>
    </div>
  );
}
