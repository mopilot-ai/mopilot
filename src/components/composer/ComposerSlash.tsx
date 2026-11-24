// Reactive composer slash-menu entries and compatibility exports for command execution.

import { selectLocalProject } from '../../store/localProjectDraft';
import { useFolderHere } from '../../lib/chatMachine';
import { useEffect, useState } from 'react';
import { ownGet, ownTable } from '../../../shared/ownTable.mjs';
import { useStore, toast } from '../../store/core';
import { navigate } from '../../store/panes';
import { showPanel } from '../../store/shellPanels';
import { startReview } from '../../store/actions';
import { currentCwdForNewChat } from '../../store/projects';
import { newChatHarness, newChatWorktreeOn, setNewChatWorktree } from '../../store/chats';
import { setUltracode } from '../../store/send';
import { whyText } from '../../harness/caps';
import { PARTS } from '../harness/parts';
import { fastBillingNote } from '../../harness/accounts';
import { setSelection, useComposerFamily, useEffectiveSelection, useHarnessAccounts } from '../../session/harness/select';
import { HARNESS_TRAITS, firstTierOf } from '../../harness/family';
import { setRemoteControl, useClaudeCommands, useClaudeSkillFiles, useCommandProvider } from '../../session/harness/claude';
import { appEntries, composeCommands } from '../../harness/commands';
import { initDesc } from '../../harness/polyfills/init';
import { COPY } from '../../harness/copy';
import { HARNESS_LABEL } from '../../harness/types';
import { openBugReport } from '../../lib/bugReportEvent';
import { loadMcpRows } from '../../session/harness/mcpRows';
import { listCodexSkills, composerCodexSkills } from '../../harness/codexCatalog';
import { native } from '../../lib/native';
import { errorText } from '../../lib/ignored';
import { effortLabel } from '../../lib/format';
import type { SkillMetadata } from '../../protocol/v2/SkillMetadata';
import type { SlashItem } from './ComposerPopups';
import {
  CreditCard,
  Gauge,
  Brain,
  Box,
  Server,
  MessageSquareText,
  ScanSearch,
  MessageCircle,
  PenLine,
  FileText,
  Network,
  SquareSlash,
  Folder,
  Zap,
  GitBranch,
  Target,
  Lightbulb,
  MonitorSmartphone,
} from '../ui/icons';
import { useSessionField } from '../../store/session/useSession';

import { blocked, SLASH_COMMANDS } from './ComposerCommands';
import { dispatchComposerCommand } from '../../lib/shortcutFocus';
import { useWorktreeSupport } from '../../lib/branchList';
import { NOT_A_REPO } from '../../../shared/worktreeSupport.mjs';
import { useDraftWorktreeFolder } from './ComposerBars';
export { blocked, SLASH_COMMANDS, runBang, type SlashCommand } from './ComposerCommands';

/* ------------------------------------------------------------------ */
/* Slash menu entries (the popups themselves are in ComposerPopups.tsx) */
/* ------------------------------------------------------------------ */
/** Why the chat's harness or login can't have Remote Control (greyed in the menu with this), or null. */
export const remoteOffWhy = (caps: { remoteControl?: { why?: Parameters<typeof whyText>[0] } }) =>
  caps.remoteControl?.why ? whyText(caps.remoteControl.why, { semantic: 'remoteControl' }) : null;

/** The folder the chat's commands, skills and menus read: its own, or the new chat's, and none for a chat on a machine (nothing of this Mac's is read for it). */
export function useChatFolderHere(threadId: string | null): string {
  const folder = useStore((s) => (threadId ? s.threads[threadId]?.cwd : null)) || currentCwdForNewChat();
  return useFolderHere(threadId, folder);
}

export function useSlashItems(
  threadId: string | null,
  planMode: boolean,
  setPlanMode: (v: boolean) => void,
  setText: (t: string) => void,
  addSkill: (name: string, path: string, displayName?: string) => void,
  {
    goalOffWhy,
    planOffWhy = null,
    attachmentOff = null,
    remoteOffWhy,
    cloudCap,
  }: {
    goalOffWhy: string | null;
    planOffWhy?: string | null;
    attachmentOff?: string | null;
    /** why the chat's harness or login can't have Remote Control, or null */
    remoteOffWhy: string | null;
    /** the composer's harness has cloud environments (the context bar shows no Worktree switch in one) */
    cloudCap: boolean;
  },
): SlashItem[] {
  useStore((s) => s.prefs);
  const worktree = useStore(newChatWorktreeOn);
  // a draft's entry follows its context bar: none where the bar has no switch or the folder isn't a repo, greyed out
  // with the reason in a repo with no commits; in a chat (never read there) it sets the default for later chats
  const draftFolder = useDraftWorktreeFolder(cloudCap);
  const noWorktree = useWorktreeSupport(draftFolder, !threadId);
  const newHarness = useStore((s) => newChatHarness(s));
  // the skills of the harness the chat is on: a basic harness lists its own (its command list)
  const family = useComposerFamily(threadId);
  // a basic chat's / menu is its own commands (Composer's basicSlashItems): no Codex or Claude selection or account is its
  const firstTier = firstTierOf(family);
  const harness = firstTier ?? newHarness;
  const { model, models, efforts, effort, fast, tiers, tier, fastUnavailable, fastHidden } = useEffectiveSelection(
    harness,
    firstTier && threadId,
  );
  const ultracode = useSessionField(threadId, (s) => s.ultracode);
  const remote = useSessionField(threadId, (s) => s.remoteControl);
  const activeAccount = useHarnessAccounts(harness).active;
  const fastNote = firstTier && fastBillingNote(firstTier, activeAccount);
  const I = { size: 16, strokeWidth: 1.7 };
  const cwd = useChatFolderHere(threadId);
  // Claude's catalog: its skills come with it, so Codex's skill list is only fetched without one
  const nativeCmds = useClaudeCommands(threadId, cwd);
  const claudeFiles = useClaudeSkillFiles(threadId, cwd);
  // Skills follow the commands, like the official menu.
  const codexReady = useStore((s) => s.conn === 'ready');
  // the folder whose Codex skills are listed; null: none are (the chat is on another harness, which has its own,
  // a harness catalog has its own, or Codex isn't ready)
  const skillsFor = attachmentOff || HARNESS_TRAITS[family].skills !== 'codexSkillList' || nativeCmds || !codexReady ? null : cwd;
  const [skills, setSkills] = useState<SkillMetadata[]>([]);
  // another folder (another chat) shows none of the last one's skills, from its first frame
  const [skillsShownFor, setSkillsShownFor] = useState(skillsFor);
  if (skillsShownFor !== skillsFor) {
    setSkillsShownFor(skillsFor);
    setSkills([]);
  }
  useEffect(() => {
    if (skillsFor === null) return;
    let generation = 0;
    const load = (forceReload = false) => {
      const current = ++generation;
      listCodexSkills(skillsFor, forceReload)
        .then((r) => {
          if (current === generation) setSkills(composerCodexSkills(r, skillsFor));
        })
        .catch(() => {
          if (current === generation) setSkills([]);
        });
    };
    const refresh = () => load(true);
    load();
    window.addEventListener('skills-changed', refresh);
    return () => {
      generation++;
      window.removeEventListener('skills-changed', refresh);
    };
  }, [skillsFor]);
  const skillTitle = (n: string) =>
    n
      .split(':')
      .map((part) => part.replace(/[-_]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()))
      .join(': ');
  const skillItems: SlashItem[] = skills
    .map((k) => ({
      id: 'skill:' + k.path,
      title: k.interface?.displayName ?? skillTitle(k.name),
      aliases: [k.name],
      desc: k.interface?.shortDescription ?? k.description,
      icon: <Box size={16} strokeWidth={1.7} />,
      skill: true,
      scope: k.scope === 'user' ? 'Personal' : k.scope === 'repo' ? 'Project' : k.scope === 'system' ? 'System' : k.scope,
      run: () => addSkill(k.name, k.path, k.interface?.displayName ?? skillTitle(k.name)),
    }))
    .sort((x, y) => x.title.localeCompare(y.title));
  if (attachmentOff)
    skillItems.push({
      id: 'skills-unavailable',
      title: 'Skills',
      desc: attachmentOff,
      disabled: attachmentOff,
      skill: true,
    });
  const items: SlashItem[] = [
    {
      id: 'chat',
      title: 'Chat',
      desc: "Don't work in a project",
      icon: <MessageCircle {...I} />,
      run: () => {
        selectLocalProject('none');
        navigate({ name: 'home' });
      },
    },
    {
      id: 'review',
      title: 'Code review',
      desc: 'Review uncommitted changes or compare against a branch',
      icon: <ScanSearch {...I} />,
      sub: async () => {
        const items: SlashItem[] = [
          {
            id: 'r-unc',
            title: 'Review uncommitted changes',
            run: () =>
              blocked(threadId, 'review') ||
              startReview(threadId, { type: 'uncommittedChanges' }).catch((e) => toast(errorText(e), 'error')),
          },
        ];
        const base = await native.git.run(cwd, ['rev-parse', '--abbrev-ref', 'origin/HEAD']);
        if (base.ok) {
          const branch = base.stdout.trim().replace(/^origin\//, '');
          items.push({
            id: 'r-base',
            title: `Review against ${branch}`,
            run: () =>
              blocked(threadId, 'review') ||
              startReview(threadId, { type: 'baseBranch', branch }).catch((e) => toast(errorText(e), 'error')),
          });
        }
        return items;
      },
    },
    // a model with several service tiers lists each one as the model names it (D-57)
    // and an account or harness that can't have Fast has no entry (a native /fast stays hidden too)
    ...(fastHidden
      ? []
      : [
          tiers.length > 1 && !fastUnavailable
            ? {
                id: 'fast',
                title: 'Speed',
                desc: [tiers.find((t) => t.id === tier)?.name ?? COPY.fast.standard, fastNote].filter(Boolean).join(' · '),
                icon: <Zap {...I} />,
                checked: fast,
                sub: async (): Promise<SlashItem[]> =>
                  [{ id: null as string | null, name: COPY.fast.standard, description: COPY.fast.standardNote }, ...tiers].map((t) => ({
                    id: 'tier-' + (t.id ?? 'standard'),
                    title: t.name,
                    desc: t.description,
                    checked: tier === t.id,
                    run: () => setSelection(harness, { tier: t.id }, threadId),
                  })),
              }
            : {
                id: 'fast',
                title: 'Fast',
                desc: [PARTS[harness].fastDesc, fastNote].filter(Boolean).join(' · '),
                icon: <Zap {...I} />,
                checked: fast,
                run: () =>
                  fastUnavailable
                    ? toast(fastUnavailable)
                    : setSelection(harness, tiers.length ? { tier: fast ? null : tiers[0].id } : { fast: !fast }, threadId),
              },
        ]),
    // MoPilot's bug report, on every harness
    {
      id: 'feedback',
      title: 'Feedback',
      desc: 'Report a bug or send feedback to MoPilot',
      icon: <MessageSquareText {...I} />,
      aliases: ['bug'],
      run: () => openBugReport(threadId),
    },
    {
      id: 'goal',
      title: 'Goal',
      desc: goalOffWhy ?? 'Set a goal to keep pursuing',
      icon: <Target {...I} />,
      disabled: goalOffWhy ?? undefined,
      run: () => setText('/goal '),
    },
    {
      id: 'init',
      title: 'Init',
      desc: initDesc(harness),
      icon: <FileText {...I} />,
      run: () => SLASH_COMMANDS.find((c) => c.name === 'init')!.run({ threadId, args: '' }),
    },
    {
      id: 'mcp',
      title: 'MCP',
      desc: 'Show MCP server status',
      icon: <Server {...I} />,
      sub: async () => {
        // the servers of the harness this chat is on now (a switched chat shows the new segment's)
        const rows = await loadMcpRows(harness, threadId);
        if (!rows.length)
          return [
            {
              id: 'mcp-none',
              title: 'No MCP servers',
              run: () => navigate({ name: 'settings', section: harness, tab: 'extensions:mcps' }),
            },
          ];
        return rows.map((m) => ({
          id: 'mcp-' + m.name,
          title: m.name,
          desc: m.desc,
          run: () => navigate({ name: 'settings', section: harness, tab: 'extensions:mcps' }),
        }));
      },
    },
    {
      id: 'model',
      title: 'Model',
      icon: <Box {...I} />,
      desc: HARNESS_LABEL[harness],
      sub: () =>
        models.map((m) => ({
          id: 'm-' + m.id,
          title: m.label,
          desc: m.description ?? undefined,
          checked: m.id === model?.id,
          run: () =>
            setSelection(harness, { model: m.id, effort: effort && m.efforts.includes(effort) ? effort : m.defaultEffort }, threadId),
        })),
    },
    {
      id: 'plan',
      title: 'Plan mode',
      desc: planOffWhy ?? (planMode ? 'Turn plan mode off' : 'Turn plan mode on'),
      disabled: planOffWhy ?? undefined,
      icon: <Lightbulb {...I} />,
      run: () => setPlanMode(!planMode),
    },
    {
      id: 'reasoning',
      title: 'Reasoning',
      desc: effortLabel(effort),
      icon: <Brain {...I} />,
      sub: () =>
        efforts.map((e: string) => ({
          id: 'e-' + e,
          title: effortLabel(e),
          checked: e === effort,
          run: () => setSelection(harness, { effort: e }, threadId),
        })),
    },
    // a session-level multi-agent switch, once the session said whether it has one (getSettings)
    ...(threadId && ultracode
      ? [
          {
            id: 'ultracode',
            title: 'Ultracode',
            desc:
              ultracode.probe !== 'ok'
                ? 'This Claude Code version changed how ultracode works · Update MoPilot'
                : !ultracode.available
                  ? "This model can't run ultracode"
                  : 'Multi-agent workflows for big tasks',
            icon: <Network {...I} />,
            checked: ultracode.on,
            run: () =>
              ultracode.probe !== 'ok' || !ultracode.available
                ? toast(
                    ultracode.probe !== 'ok'
                      ? 'This Claude Code version changed how ultracode works · Update MoPilot'
                      : "This model can't run ultracode",
                  )
                : setUltracode(threadId, !ultracode.on),
          },
        ]
      : []),
    // The chat's Remote Control (/remote-control): a chat on a harness without one sees it greyed out with the reason. One that
    // links the whole computer is switched in the side panel's Session section, which asks first, so this opens it.
    ...(threadId
      ? [
          (() => {
            const linked = ['on', 'connecting', 'offline', 'signin'].includes(remote?.state ?? '');
            const why = remoteOffWhy ?? undefined;
            if (firstTier && HARNESS_TRAITS[firstTier].remoteControl === 'computer')
              return {
                id: 'remote-control',
                title: 'Remote Control',
                desc: why ?? 'Turn it on in the side panel',
                icon: <MonitorSmartphone {...I} />,
                checked: false,
                disabled: why,
                run: () => showPanel('summary', true),
              };
            return {
              id: 'remote-control',
              title: 'Remote Control',
              desc:
                why ??
                (remote?.state === 'on'
                  ? 'Linked to claude.ai'
                  : remote?.state === 'connecting'
                    ? 'Connecting…'
                    : (remote?.error ?? 'Follow this chat from claude.ai or the Claude app')),
              icon: <MonitorSmartphone {...I} />,
              checked: linked,
              disabled: why,
              run: () => setRemoteControl(threadId, !linked),
            };
          })(),
        ]
      : []),
    {
      id: 'sketch',
      title: 'Sketch',
      desc: 'Draw a sketch',
      icon: <PenLine {...I} />,
      run: () => dispatchComposerCommand('open-sketch'),
    },
    {
      id: 'status',
      title: 'Status',
      desc: 'Show chat ID, context usage, and rate limits',
      icon: <Gauge {...I} />,
      run: () => window.dispatchEvent(new CustomEvent('open-status', { detail: threadId })),
    },
    {
      id: 'usage',
      title: 'Accounts & billing',
      desc: 'Open accounts, usage and billing settings',
      icon: <CreditCard {...I} />,
      run: () => navigate({ name: 'settings', section: 'accounts' }),
    },
    {
      id: 'workin',
      title: 'Work in a project',
      desc: 'Choose project for new chats',
      icon: <Folder {...I} />,
      run: () => dispatchComposerCommand('open-project-menu'),
    },
    ...(threadId || (noWorktree !== undefined && noWorktree !== NOT_A_REPO)
      ? [
          {
            id: 'worktree',
            title: 'Worktree',
            desc: noWorktree ?? (worktree ? 'Turn worktree mode off' : 'Turn worktree mode on'),
            icon: <GitBranch {...I} />,
            disabled: noWorktree ? `Worktree unavailable: ${noWorktree}` : undefined,
            run: () => setNewChatWorktree(!worktree),
          },
        ]
      : []),
    ...skillItems,
  ];
  const provider = useCommandProvider(threadId, cwd);
  if (!provider) return items;
  const registry = composeCommands(provider);
  const listed = registry.menu.filter((c) => c.dispatch === 'passthrough');
  const nativeNames = new Set(listed.flatMap((c) => [c.name, ...(c.aliases ?? [])]));
  // Sage's own entries stay for what Sage draws itself; the rest give way to the harness's command
  const kept = items.filter((it) => SAGE_SLASH.has(it.id) || !nativeNames.has(it.id));
  const ids = new Set(kept.map((it) => it.id));
  if (fastHidden) ids.add('fast');
  // the App group: what Sage runs itself and the menu above doesn't already draw, labelled as Sage's
  const app: SlashItem[] = appEntries(registry.menu, ids, new Set(SLASH_COMMANDS.map((x) => x.name)), NO_APP_ENTRY).map((c) => ({
    id: c.name,
    title: `/${c.name}`,
    desc: c.description,
    icon: <SquareSlash {...I} />,
    scope: c.source === 'app' ? 'App' : undefined,
    aliases: c.aliases,
    disabled: c.why ? whyText(c.why, { label: provider.label, semantic: c.semantic }) : undefined,
    run: () => (c.hint ? setText(`/${c.name} `) : SLASH_COMMANDS.find((x) => x.name === c.name)!.run({ threadId, args: '' })),
  }));
  for (const it of app) ids.add(it.id);
  return [
    ...kept,
    ...app,
    ...listed
      .filter((c) => !ids.has(c.name))
      .map((c) => ({
        id: c.name,
        title: `/${c.name}${c.aliases?.length ? ` (/${c.aliases.join(', /')})` : ''}`,
        disabled: c.source === 'skill' ? (attachmentOff ?? undefined) : undefined,
        desc: c.description,
        icon: c.source === 'skill' ? <Box {...I} /> : <SquareSlash {...I} />,
        scope: c.source === 'skill' ? (CLAUDE_SCOPE[ownGet(claudeFiles, c.name)?.scope ?? ''] ?? 'Skill') : undefined,
        skill: c.source === 'skill',
        nativeSkill: c.source === 'skill' ? c.name : undefined,
        aliases: c.aliases,
        run: () => setText(`/${c.name} `),
      })),
  ];
}

/** The scope label a Claude skill row carries, in the words Codex's rows use. */
const CLAUDE_SCOPE: Record<string, string> = ownTable({ personal: 'Personal', project: 'Project', plugin: 'Plugin' });

/** Typed-only: the menu above has its own entry (Feedback, which /bug also finds) or the command needs a chat's history. */
const NO_APP_ENTRY = new Set(['feedback', 'bug', 'goal', 'review', 'status', 'mcp', 'init', 'model', 'plan']);

/** "/" entries Sage keeps even where the harness has a command of that name. */
const SAGE_SLASH = new Set([
  'model',
  'goal',
  'plan',
  'fast',
  'status',
  'feedback',
  'reasoning',
  'ultracode',
  'remote-control',
  'chat',
  'sketch',
  'worktree',
  'workin',
]);
