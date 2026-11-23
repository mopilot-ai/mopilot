// Composer command execution, capability refusals, init-file recovery and shell-output sending.

import { sendMessage } from '../../store/send';
import { bangMessage } from '../../lib/bangMessage';
import { navigate, openChanges, toggleTasksPane } from '../../store/panes';
import { compactThread, forkThread, startReview, renameThread } from '../../store/actions';
import { blockedReason } from '../../store/chats';
import { toast, get as getState } from '../../store/core';
import { currentCwdForNewChat } from '../../store/projects';
import { showPanel } from '../../store/shellPanels';
import { runGoalCommand } from '../../session/harness/goalCommand';
import { isClaudeComposer, logoutRoute } from '../../session/harness/select';
import { planInit, initPrompt, machineInit, hasPointer, withPointer } from '../../harness/polyfills/init';
import { runShell, shellAttachment } from '../../harness/polyfills/shell';
import { openBugReport } from '../../lib/bugReportEvent';
import { native } from '../../lib/native';
import { errorText, noteIgnored } from '../../lib/ignored';
import { sessionOf } from '../../store/session/useSession';
import { turnBusy } from '../../store/session/sessionState';
import { OPEN_DESIGN_LOGIN } from '../dialogs/designLoginEvent';
import { focusedChat } from '../../store/split';
import { chatFolderHere, hostOfChatNow } from '../../lib/hostChats';
import { localInitFolder, machineInitFolder } from '../../lib/initFolder';
import { hostRunsClaude } from '../../store/machineChatSwitch';

/** What a command that works on this Mac's folder says in a chat on a machine. */
const ON_MACHINE = 'Not available for a chat on a machine.';
import { dispatchComposerCommand } from '../../lib/shortcutFocus';

/** What the composer draws of its chat's session: useSessionField compares these fields shallowly, so other patches don't redraw it. */
export const composerFields = (s: import('../../store/session/sessionState').SessionState) => ({
  plan: s.plan,
  tasks: s.tasks,
  runningElsewhere: s.runningElsewhere,
  remoteControl: s.remoteControl,
});

/**
 * What Sage runs for a command; names, descriptions and dispatch come from the registry (harness/commands.ts).
 * `run` resolves false when what it sends didn't go out (sendMessage already said why): the composer then puts
 * the typed command back. Any other answer counts as done.
 */
export interface SlashCommand {
  name: string;
  run: (ctx: { threadId: string | null; args: string }) => unknown;
  needsThread?: boolean;
  /** it uses the text typed after it; any other command leaves that text in the box */
  takesText?: true;
}

/** A capability the chat's harness can't run right now (a failed version probe): say why instead. */
export function blocked(threadId: string | null, s: Parameters<typeof blockedReason>[1]) {
  const why = blockedReason(threadId, s);
  if (why) toast(why, 'error');
  return !!why;
}

export const SLASH_COMMANDS: SlashCommand[] = [
  {
    name: 'model',
    run: () => {
      dispatchComposerCommand('open-model-picker');
    },
  },
  {
    name: 'permissions',
    run: () => {
      dispatchComposerCommand('open-permission-picker');
    },
  },
  {
    name: 'review',
    takesText: true,
    run: ({ threadId, args }) =>
      blocked(threadId, 'review') ||
      startReview(threadId, args ? { type: 'custom', instructions: args } : { type: 'uncommittedChanges' }).catch((e) =>
        toast(errorText(e), 'error'),
      ),
  },
  {
    name: 'new',
    // /clear (an alias): the chat it leaves lets go of what it holds, as a terminal's /clear ends its browser tab group
    run: ({ threadId }) => {
      if (threadId)
        // best effort: the chat may hold nothing to release
        native.session.release(threadId).catch((e) => noteIgnored('release what a chat holds on /new', e));
      return navigate({ name: 'home' });
    },
  },
  {
    name: 'goal',
    takesText: true,
    run: ({ threadId, args }) => runGoalCommand(threadId, args),
  },
  { name: 'init', takesText: true, run: ({ threadId, args }) => runInit(threadId, args) },
  {
    name: 'compact',
    needsThread: true,
    takesText: true,
    // Refusal keeps the command and its instructions available for retry.
    run: ({ threadId, args }) => (threadId && !blocked(threadId, 'compact') ? compactThread(threadId, args) : false),
  },
  { name: 'fork', needsThread: true, run: ({ threadId }) => threadId && forkThread(threadId) },
  { name: 'tasks', needsThread: true, run: ({ threadId }) => threadId && toggleTasksPane(threadId) },
  { name: 'diff', run: () => openChanges() },
  { name: 'status', run: () => showPanel('summary', true) },
  { name: 'mcp', run: () => navigate({ name: 'settings', section: 'plugins', tab: 'mcps' }) },
  { name: 'skills', run: () => navigate({ name: 'plugins', tab: 'skills' }) },
  {
    name: 'rename',
    needsThread: true,
    takesText: true,
    run: async ({ threadId, args }) => {
      if (!threadId || !args.trim()) return toast('Usage: /rename <new name>');
      await renameThread(threadId, args.trim());
    },
  },
  { name: 'settings', run: () => navigate({ name: 'settings' }) },
  // one MoPilot-only bug report on every harness (Dialogs.tsx draws it)
  { name: 'bug', run: ({ threadId }) => openBugReport(threadId) },
  { name: 'feedback', run: ({ threadId }) => openBugReport(threadId) },
  // the accounts page opens on the chat's account row; the user signs out there, whichever harness the chat is on (D-26)
  { name: 'logout', run: ({ threadId }) => navigate(logoutRoute(threadId)) },
  // Claude Design's sign-in, on the chat's Claude account (Dialogs.tsx draws it)
  { name: 'design-login', run: ({ threadId }) => window.dispatchEvent(new CustomEvent(OPEN_DESIGN_LOGIN, { detail: threadId })) },
];

/** Wait for the chat's turn to start and end (at most `maxMs`), then add the pointer line to the file /init wrote. */
async function appendPointerAfterTurn(chatId: string, file: string, maxMs = 15 * 60_000) {
  const until = Date.now() + maxMs;
  let started = false;
  const t0 = Date.now();
  while (Date.now() < until) {
    const busy = turnBusy(sessionOf(chatId));
    if (busy) started = true;
    if (started && !busy) break;
    if (!started && Date.now() - t0 > 10_000) return;
    await new Promise((r) => setTimeout(r, 400));
  }
  const text = await native.fs.readText(file);
  if (text === null) return;
  const next = withPointer(text, 'claude');
  if (next !== text) await native.fs.writeText(file, next);
}

/**
 * /init (by MoPilot). Codex has none: it asks before replacing AGENTS.md and offers to let Codex also read
 * CLAUDE.md. Claude runs its own and goes out as typed; when AGENTS.md exists it offers to let Claude read it
 * too, and adds the @AGENTS.md line to CLAUDE.md after /init has run.
 * A chat on a machine does the same on the machine's folder: its files are read there (the Host's read-only `fs.read`)
 * and nothing is written from here, so the @AGENTS.md line goes to the agent as one more instruction of the command.
 */
async function runInit(threadId: string | null, args = '') {
  const chatCwd = (threadId ? getState().threads[threadId]?.cwd : null) || currentCwdForNewChat();
  const cwd = await chatFolderHere(threadId, chatCwd);
  // a chat on a machine: its folder is the machine's, read there
  const machine = chatCwd && !cwd ? hostOfChatNow(threadId) : null;
  const folder = machine ? machineInitFolder(machine, chatCwd) : localInitFolder(cwd);
  // a chat on a machine is drawn as an ACP chat: the agent its machine runs it on decides
  const claude = isClaudeComposer(threadId) || (!!machine && hostRunsClaude(threadId!));
  // a read that fails (the machine did not answer) is the command's toast, and nothing is sent
  const [agents, claudeMd] = await Promise.all([
    folder.exists('AGENTS.md'),
    claude ? folder.text('CLAUDE.md') : folder.exists('CLAUDE.md'),
  ]);
  const plan = planInit(claude ? 'claude' : 'codex', {
    agents,
    claude: !!claudeMd,
    pointed: claude && typeof claudeMd === 'string' && hasPointer(claudeMd, 'claude'),
  });
  if (claude) {
    const accepted = !!plan?.offer && window.confirm(plan.offer.text);
    const typed = args.trim() ? `/init ${args.trim()}` : '/init';
    if ((await sendMessage(threadId, machine ? machineInit(plan, typed, accepted) : typed, [], { human: true })) === false) return false;
    const id = threadId ?? focusedChat(getState());
    if (accepted && id && !machine)
      // CLAUDE.md works without the line, but the user asked for it: say it wasn't added
      appendPointerAfterTurn(id, folder.path('CLAUDE.md')).catch((e) =>
        toast(`Couldn't add the @AGENTS.md line to CLAUDE.md: ${errorText(e)}`, 'error'),
      );
    return;
  }
  // a chat's composer is on Codex or Claude, and Codex always has a plan
  if (plan!.confirmOverwrite && !window.confirm(`${plan!.confirmOverwrite}\n\nOK replaces it, Cancel keeps it.`)) return;
  const accepted = !!plan!.offer && window.confirm(plan!.offer.text);
  return (await sendMessage(threadId, initPrompt(plan!, accepted), [], { human: true })) !== false;
}

/**
 * Claude's `!cmd` (by MoPilot): runs in Sage's pty, outside Claude Code's sandbox; the output goes along as an
 * attachment. Resolves false when the output didn't go out (the command failed, or main refused the send; either
 * said why), so the composer keeps the command line.
 */
export async function runBang(threadId: string | null, cmd: string): Promise<boolean> {
  const chatCwd = (threadId ? getState().threads[threadId]?.cwd : null) || currentCwdForNewChat();
  const cwd = await chatFolderHere(threadId, chatCwd);
  // the shell is this Mac's: for a chat on a machine it would run in the wrong place
  if (chatCwd && !cwd) return toast(ON_MACHINE, 'error'), false;
  toast(`Running ${cmd}…`);
  try {
    const r = await runShell(native.pty, cmd, cwd);
    const out = shellAttachment(r);
    const sent = await sendMessage(threadId, bangMessage(cmd), [{ kind: 'selection', path: '', name: 'Shell output', text: out.text }], {
      human: true,
    });
    return sent !== false;
  } catch (e) {
    toast(errorText(e), 'error');
    return false;
  }
}
