// New-chat creation: captured draft targets, asynchronous workspace preparation and startup rows across every harness.
import type { HarnessFamily } from '../harness/family';
import type { AppState, SavedProject } from './state';
import { native } from '../lib/native';
import { errorText } from '../lib/ignored';
import { get, set, setPrefs, toast } from './core';
import { newChatBasic, newChatFamily, newChatWorktreeOn, startingHarness, temporaryChatBlocked } from './chats';
import {
  setChatConfig,
  newChatBase,
  newChatHostPick,
  projectlessCwd,
  newWorktree,
  startThread,
  fetchedPullRequest,
  fetchedIssue,
  fetchedLinear,
} from './projects';
import { navigate } from './panes';
import { takeClaudeSession } from './prewarm';
import { runtime } from './runtime';
import { chooseHostAgent, wantedHostAgent } from '../harness/hostAgent';
import { readMachineAgents, readMachineRow } from '../lib/hostMachines';
import { chooseRepositoryLocation, repositoryDraftProblem, verifyRepositoryMachine } from './repositoryDraft';
import { consumeDraftHarness } from './draftHarness';
import { machineStartFolder } from './machineStart';
import { showChatStart } from '../lib/chatStarts';
import { hostPermissionFamily, startingHostMode } from '../../shared/host/permissions.mjs';

/** A new chat on each harness, in `cwd` (and the project new chats go to); `basic` is the picked basic harness. */
export type NewChat = { cwd: string; proj: SavedProject | null; ephemeral: true | undefined; basic: string | null };
const START_NEW: Record<HarnessFamily, (o: NewChat) => string | Promise<string>> = {
  codex: ({ cwd, proj, ephemeral }) => startThread({ cwd, projectId: proj?.codexId ?? null, localProjectId: proj?.id, ephemeral }),
  // a temporary chat takes no prewarmed CLI (#1664): it isn't warmed
  claude: async ({ cwd, proj, ephemeral }) =>
    runtime().startClaudeThread({ cwd, projectId: proj?.id ?? null, ephemeral, ...(ephemeral ? {} : await takeClaudeSession(cwd)) }),
  // newChatFamily is ACP only with a picked basic harness, and never for a temporary chat
  acp: ({ cwd, proj, basic }) => runtime().startAcpThread({ cwd, projectId: proj?.id ?? null, harness: basic! }),
};

/** A new chat on `family`'s harness (`o.basic` names the basic one), started now rather than by its first message. */
export function startNewChat(family: HarnessFamily, o: NewChat): Promise<string> {
  return Promise.resolve(START_NEW[family](o));
}

/** Why a machine picked with no folder yet cannot start a chat: an offline machine has no folder list to pick from (its chip does not open the picker), so the cause is said, with Check again; an online one is asked for a folder. */
async function noFolderToast(host: NonNullable<AppState['newChatHost']>) {
  if ((await readMachineRow(host.id))?.status !== 'offline') return toast(`Pick a folder on ${host.name}.`, 'error');
  toast(`${host.name} is offline. Check again, or pick another machine.`, 'error', {
    action: { label: 'Check again', run: () => void native.host?.check().catch((e) => toast(errorText(e), 'error')) },
  });
}

/** A new chat in a folder on another machine, on the agent picked for new chats; a temporary chat can't be kept off the machine's disk, so it is told so, the draft kept. */
export async function createHostChatThread(host: NonNullable<AppState['newChatHost']>): Promise<string | null> {
  const s = get();
  if (s.newChatTemporary) return toast(`Temporary chats can't run on ${host.name}.`, 'error'), null;
  // a machine picked in the host chip with no folder used there yet: the draft stays until one is picked
  if (!host.path) {
    await noFolderToast(host);
    return null;
  }
  // a basic agent by its id, Claude Code and Codex by their family: the machine runs them all. Whether one can run on this Mac does not matter there: the pick counts as saved
  // the machine's own readiness decides which agent it can run, not this Mac's sign-ins; a row that reports none (an older Host) keeps the saved pick and lets the machine refuse
  const agents = await readMachineAgents(host.id);
  const want = wantedHostAgent({
    pick: host.agent,
    draft: s.newChatHarnessPick,
    remembered: s.prefs.hostPicks[host.id]?.agent,
    saved: startingHarness(s),
    agents,
  });
  const choice = chooseHostAgent(want, agents, host.name);
  if (choice && !choice.harness) return toast(choice.note!, 'error'), null;
  const harness = choice?.harness ?? want;
  let id: string;
  try {
    const selected = s.newChatRepositoryGroup;
    const verified = selected ? await verifyRepositoryMachine(selected, host) : null;
    if (selected && !verified) return toast(chooseRepositoryLocation, 'error'), null;
    // Read and write branches through the same Host registration verified for this draft.
    const path = await machineStartFolder(host, s, verified?.scope ?? host.scope);
    if (selected && get().newChatRepositoryGroup !== selected) return null;
    id = await runtime().startHostAcpThread({ host: { ...host, path, ...verified }, harness });
  } catch (e) {
    toast(`Failed to start chat: ${errorText(e)}`, 'error');
    return null;
  }
  // a family the Host's permission modes apply to (Claude Code, Codex) starts in the mode the composer showed: the machine's own pick, else this Mac's default, as a chat here would
  if (hostPermissionFamily(harness))
    setChatConfig(id, {
      hostPermission: {
        hostId: host.id,
        harness,
        value: startingHostMode({ pick: host.permission, hostId: host.id, harness, macDefault: s.prefs.permission }),
      },
    });
  const selection = host.selection?.hostId === host.id && host.selection.harness === harness ? host.selection : null;
  if (selection) setChatConfig(id, { hostSelection: selection });
  // picking this machine for a new chat starts in this folder again, on the same agent, model and effort, also while the machine is away
  const p = get().prefs;
  setPrefs({
    hostFolders: { ...p.hostFolders, [host.id]: host.path },
    hostPicks: {
      ...p.hostPicks,
      [host.id]: { agent: harness, ...(selection ? { model: selection.model, effort: selection.effort } : {}) },
    },
  });
  set((st) => consumeDraftHarness(st, s));
  // the draft's own Worktree choice ends with the chat that used it (one changed while it started belongs to the next draft)
  set((st) => (st.newChatWorktree === s.newChatWorktree ? { newChatWorktree: null, newChatWorktreeHintOff: null } : {}));
  navigate({ name: 'thread', id });
  return id;
}

/** Why a pull request that only a copy can hold (a fork's, or one no longer open) needs the Worktree switch on. */
const needsWorktree = (pr: { number: number; fork: boolean }) =>
  `Turn on Worktree to work on #${pr.number}: ${pr.fork ? 'it comes from a fork' : 'it is no longer open, so its branch may be gone'}.`;

/**
 * A new chat for the draft. `typed: false` (a voice chat) has no typed first message to carry a picked issue, so the
 * issue is neither read nor used, and its pick stays for a chat that has one.
 */
export async function createChatThread(seed: string, { typed = true }: { typed?: boolean } = {}): Promise<string | null> {
  const s = get();
  const locationProblem = repositoryDraftProblem(s, null);
  if (locationProblem) return toast(locationProblem, 'error'), null;
  // a temporary chat set up while the harness it runs on could run, and can't now: refused with why, the text kept
  const blocked = s.newChatTemporary ? temporaryChatBlocked(s) : null;
  if (blocked) return toast(blocked, 'error'), null;
  // a folder on another machine is no path on this one: the chat starts there, not here
  const hostPick = newChatHostPick(s);
  let id: string;
  const { explicitCwd, proj, cwd: baseCwd } = hostPick ? { explicitCwd: null, proj: null, cwd: hostPick.path } : newChatBase(s);
  let cwd = baseCwd;
  const finish = s.newChatTemporary ? () => undefined : showChatStart(seed, { cwd, projectId: proj?.id ?? null, hostId: hostPick?.id });
  try {
    if (hostPick) return await createHostChatThread(hostPick);
    if (!cwd) cwd = await projectlessCwd(seed);
    // the branch picked in the context bar: the worktree's base, or checked out in place without one
    const pick = s.newChatBranch?.path === cwd ? s.newChatBranch : null;
    const picked = pick?.branch ?? null;
    // the folder a worktree chat came from, kept for every harness: restoring a pruned worktree and the sidebar need it
    let repo: string | null = null;
    // a folder that can't hold a worktree (the switch is off there and says why) runs the chat in the folder itself
    // an existing worktree picked for this folder (a Conductor workspace brought over): the chat runs there as it is,
    // on the branch it has, and nothing is made or switched
    const space = s.newChatWorkspace?.root === cwd ? s.newChatWorkspace : null;
    const worktree = !space && newChatWorktreeOn(s) && !!(proj || explicitCwd);
    // a pull request picked there (not with a workspace, which the chip then hides): one only a copy can hold is refused
    // before any network work without a worktree; else found again (it may have changed) and its head fetched
    const pull = space ? undefined : pick?.pullRequest;
    if (pull && !pull.own && !worktree) throw new Error(needsWorktree(pull));
    const pr = pull ? await fetchedPullRequest(cwd, pull.number) : null;
    // an issue picked there: read again now (it may have changed), before anything is made, for the first message to carry
    const issue = typed && !space && pick?.issue ? await fetchedIssue(cwd, pick.issue.number) : null;
    // a Linear issue the same way; with a worktree, its branch is the one Linear suggests
    const linear = typed && !space && !pr && pick?.linear ? await fetchedLinear(pick.linear.key) : null;
    const wt = worktree ? await newWorktree(cwd, picked, pr, linear?.branch ?? null) : null;
    if (space) {
      // picked a while ago, perhaps on a page no longer shown: a workspace removed since would leave a chat with no folder
      const there = await native.git.worktreeInfo(space.path);
      if (!there?.adopted || there.path !== space.path) {
        set((st) => (st.newChatWorkspace === s.newChatWorkspace ? { newChatWorkspace: null } : {}));
        throw new Error(`The workspace ${space.name} is gone. Pick where to run the chat again.`);
      }
      repo = cwd;
      cwd = space.path;
      toast(`Working in ${space.name}`);
    } else if (wt && 'path' in wt) {
      repo = cwd;
      cwd = wt.path;
      toast(`Working in worktree on ${wt.branch}`);
    } else if (pr && !pr.own) {
      // its branch is not an open one of origin's (it changed since it was picked, or no worktree could be made here)
      throw new Error(needsWorktree(pr));
    } else if (picked) {
      const sw = await native.git.switchBranch(cwd, pr?.checkout ?? picked);
      if (!sw.ok) throw new Error(sw.error);
    }
    // the harness newChatFamily names: a temporary chat picked on a basic harness runs on the first tier
    id = await START_NEW[newChatFamily(s)]({ cwd, proj, ephemeral: s.newChatTemporary || undefined, basic: newChatBasic(s) });
    if (repo) set((st) => ({ worktreeOf: { ...st.worktreeOf, [id]: repo } }));
    const task = issue
      ? { text: issue.context, fromTitle: `#${issue.number} ${issue.title}` }
      : linear
        ? { text: linear.context, fromTitle: `${linear.key} ${linear.title}` }
        : null;
    if (task) set((st) => ({ handoffCarry: { ...st.handoffCarry, [id]: { ...task, issue: true } } }));
    if (s.newChatTemporary) set({ newChatTemporary: false });
    // the draft's own Worktree choice and dismissed suggestion end with it: the next one starts from the saved default.
    // One the user changed while this chat was starting belongs to the next draft and stays.
    set((st) =>
      st.newChatWorktree === s.newChatWorktree && st.newChatWorktreeHintOff === s.newChatWorktreeHintOff
        ? { newChatWorktree: null, newChatWorktreeHintOff: null }
        : {},
    );
    set((st) => (st.newChatWorkspace === s.newChatWorkspace ? { newChatWorkspace: null } : {}));
    // and a pull request or issue it picked: the pull request's branch is now in use (another chat starting from it would
    // be refused), and the issue went with this chat
    const once = s.newChatBranch?.pullRequest || (typed && (s.newChatBranch?.issue || s.newChatBranch?.linear));
    set((st) => (st.newChatBranch === s.newChatBranch && once ? { newChatBranch: null } : {}));
    // so does the harness the draft picked: the next new chat starts on the saved default again
    set((st) => consumeDraftHarness(st, s));
    navigate({ name: 'thread', id });
    return id;
  } catch (e) {
    toast(`Failed to start chat: ${errorText(e)}`, 'error');
  } finally {
    finish();
  }
  return null;
}
