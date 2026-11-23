// The composer's add menu (files, images, plugins, sketch, a message to another chat, Computer History), the sketch pad, and the mode and permission pickers.
import { ownsComposerCommand } from '../../lib/shortcutFocus';

import { useEffect, useState } from 'react';
import { setPrefs, toast } from '../../store/core';
import { setChatConfig } from '../../store/projects';
import { ProjectMenu } from './ProjectMenu';
import { useChatPermission } from '../../session/useComposerHarness';
import { PLAN_PERMISSION_HINT, effectivePermission } from '../../../shared/effectivePermission.mjs';
import { PERMISSION_LABEL } from '../../../shared/permissionMenu.mjs';
import { useStore } from '../../store/core';
import { permissionMenu } from '../../harness/permissionsMenu';
import { useEffectiveSelection } from '../../session/harness/select';
import type { HarnessId } from '../../harness/types';
import { PluginLogo } from '../harness/codex/Plugins';
import { listsCodexPlugins } from '../../harness/entries';
import { listCodexPlugins } from '../../harness/codexCatalog';
import { permissionIcon } from '../harnessPicker/permissionIcon';
import { ModePicker } from '../harnessPicker/ModePicker';
import type { PluginSummary } from '../../protocol/v2/PluginSummary';
import { Popover, Tooltip, useAnchor } from '../ui/Popover';
import { MenuList, MenuRow } from '../ui/MenuList';
import { WebLink } from '../ui/WebLink';
import { isEnter, listKey } from '../../lib/focus';
import { errorText } from '../../lib/ignored';
import { Plus, PenLine, Paperclip, Folder, Check, Target, Lightbulb, Send, Mic } from '../ui/icons';
import { SketchPad } from './SketchPad';
import { Circle, History } from 'lucide-react';
import type { Attachment } from '../../store/types';
import type { CapView } from '../../store/session/capsTypes';
import { ComputerHistoryShare } from './ComputerHistoryShare';
import { RecordSkill } from './RecordSkill';

/* ------------------------------------------------------------------ */
/* Add (+) panel: full-width list above the composer                   */
/* ------------------------------------------------------------------ */
/** A row of the add menu: a built-in action or an installed plugin. */
type AddItem = {
  key: string;
  icon: React.ReactNode;
  title: string;
  desc?: string | null;
  disabled?: string;
  run: () => void;
  plugin?: boolean;
};

/** The + menu's items that belong to the coding side, left out of a MoMo chat's menu. */
const CODING_ONLY = new Set(['project', 'goal', 'plan', 'peer', 'record']);

export function AttachMenu({
  onSketch,
  onPickFiles,
  attachmentOff = null,
  onMention,
  onGoal,
  goalOff: goalOffWhy,
  composerEl,
  harness: plusHarness,
  planMode,
  planOff = null,
  setPlanMode,
  onMessageChat,
  historyCap,
  onAttach,
  threadId = null,
  momo = false,
  onAudioMessage,
}: {
  /** the first-tier harness, or null on a basic harness (it lists no Codex plugins) */
  harness: HarnessId | null;
  attachmentOff?: string | null;
  onSketch: (dataUrl: string) => Promise<boolean>;
  onPickFiles: () => void | Promise<void>;
  onMention: (name: string, path: string) => void;
  onGoal: () => void;
  /** why Goal can't be used in this chat */
  goalOff: string | null;
  composerEl: HTMLElement | null;
  planMode: boolean;
  planOff?: string | null;
  setPlanMode: (v: boolean) => void;
  /** opens the dialog that sends this chat's request to another chat (absent before the chat exists) */
  onMessageChat?: () => void;
  /** the chat's computerHistory capability: whether and how it takes shared memories */
  historyCap?: CapView;
  /** adds an attachment the menu built (shared Computer History) */
  onAttach: (a: Attachment) => void;
  /** the chat Record a skill records for (null: the new chat's box) */
  threadId?: string | null;
  /** a MoMo chat's menu (#2279): files, Computer History and a sketch, none of the coding side's projects, goal, plan, chats or plugins */
  momo?: boolean;
  /** records an audio message for an agent that takes audio (its audioInput capability); absent elsewhere */
  onAudioMessage?: () => void;
}) {
  const a = useAnchor();
  const [plugins, setPlugins] = useState<PluginSummary[]>([]);
  // why the installed plugins couldn't be listed (the panel says so instead of showing none)
  const [pluginsFailed, setPluginsFailed] = useState<string | null>(null);
  const [idx, setIdx] = useState(0);
  const [sketch, setSketch] = useState(false);
  const [share, setShare] = useState(false);
  const [recording, setRecording] = useState(false);
  const proj = useAnchor();
  useEffect(() => {
    // /sketch reaches the focused pane's composer alone
    const sk = (event: Event) => {
      if (ownsComposerCommand(event, a.anchor)) {
        setSketch(true);
      }
    };
    // a MoMo chat has no project: the project-picker shortcut opens nothing there
    const pm = (event: Event) => {
      if (!momo && ownsComposerCommand(event, a.anchor)) proj.setOpen(true);
    };
    window.addEventListener('open-sketch', sk);
    window.addEventListener('open-project-menu', pm);
    return () => {
      window.removeEventListener('open-sketch', sk);
      window.removeEventListener('open-project-menu', pm);
    };
    // a state setter: the listeners are added once
  }, [proj.setOpen, a.anchor, momo]);
  useEffect(() => {
    if (!a.open) return;
    setIdx(0);
    setPluginsFailed(null);
    // the marketplace is Codex's: another harness's chat lists none of it, and a MoMo chat none at all
    if (attachmentOff || momo || !listsCodexPlugins(plusHarness)) return void setPlugins([]);
    let live = true;
    listCodexPlugins()
      .then((r) => {
        if (!live) return;
        const markets = r.marketplaces ?? [];
        setPlugins(
          markets
            // ChatGPT apps first, as in the official panel
            .sort((x, y) => Number(y.name === 'openai-curated-remote') - Number(x.name === 'openai-curated-remote'))
            .flatMap((m) => m.plugins ?? [])
            .filter((p) => p.installed && p.enabled !== false && p.installPolicy !== 'INSTALLED_BY_DEFAULT')
            .filter((p) => !markets.some((m) => ['openai-bundled', 'openai-primary-runtime'].includes(m.name) && m.plugins?.includes(p)))
            .filter((p, i: number, arr) => arr.findIndex((x) => x.name === p.name) === i),
        );
      })
      .catch((e) => {
        if (!live) return;
        setPlugins([]);
        setPluginsFailed(errorText(e));
      });
    return () => {
      live = false;
    };
  }, [a.open, plusHarness, momo, attachmentOff]);
  const items: AddItem[] = [
    {
      key: 'files',
      icon: <Paperclip size={16} strokeWidth={1.7} />,
      title: 'Files and folders',
      run: onPickFiles,
    },
    {
      key: 'project',
      icon: <Folder size={16} strokeWidth={1.7} />,
      title: 'Work in a project',
      desc: 'Choose project for new chats',
      run: () => proj.setOpen(true),
    },
    {
      key: 'goal',
      icon: <Target size={16} strokeWidth={1.7} />,
      title: 'Goal',
      desc: goalOffWhy ?? 'Set a goal to keep pursuing',
      disabled: goalOffWhy ?? undefined,
      run: onGoal,
    },
    {
      key: 'plan',
      icon: <Lightbulb size={16} strokeWidth={1.7} />,
      title: 'Plan mode',
      desc: planOff ?? (planMode ? 'Turn plan mode off' : 'Turn plan mode on'),
      disabled: planOff ?? undefined,
      run: () => setPlanMode(!planMode),
    },
    {
      key: 'history',
      icon: <History size={16} strokeWidth={1.7} />,
      title: 'Computer History',
      desc: 'Share what you were working on',
      disabled: historyCap?.state === 'native' || historyCap?.state === 'sage' ? undefined : "This chat can't take shared memories",
      run: () => setShare(true),
    },
    {
      key: 'record',
      icon: <Circle size={16} strokeWidth={1.7} />,
      title: 'Record a skill',
      desc: 'Show a task once to make it repeatable',
      disabled: historyCap?.state === 'native' || historyCap?.state === 'sage' ? undefined : "This chat can't take a recording",
      run: () => setRecording(true),
    },
    { key: 'sketch', icon: <PenLine size={16} strokeWidth={1.7} />, title: 'Sketch', desc: 'Draw a sketch', run: () => setSketch(true) },
    ...(onAudioMessage
      ? [
          {
            key: 'audio',
            icon: <Mic size={16} strokeWidth={1.7} />,
            title: 'Audio message',
            desc: 'Record audio for the agent to hear',
            run: onAudioMessage,
          },
        ]
      : []),
    ...(onMessageChat
      ? [
          {
            key: 'peer',
            icon: <Send size={16} strokeWidth={1.7} />,
            title: 'Message another chat',
            desc: 'Ask another chat and get its answer here',
            run: onMessageChat,
          },
        ]
      : []),
  ];
  const available = attachmentOff
    ? items.map((item) =>
        ['history', 'record', 'audio'].includes(item.key) ? { ...item, disabled: attachmentOff, desc: attachmentOff } : item,
      )
    : items;
  const all: AddItem[] = momo
    ? available.filter((item) => !CODING_ONLY.has(item.key))
    : [
        ...available,
        ...plugins.map((p) => ({
          key: 'plugin:' + p.id,
          icon: <PluginLogo p={p} size={16} />,
          title: p.interface?.displayName ?? p.name.replace(/[-_]+/g, ' ').replace(/\b\w/g, (c: string) => c.toUpperCase()),
          desc: p.interface?.shortDescription,
          run: () => onMention(p.name, `plugin://${p.id}`),
          plugin: true,
        })),
      ];
  useEffect(() => {
    if (!a.open) return;
    const h = (e: KeyboardEvent) => {
      // the composer keeps focus while the panel is open: only arrows and Enter are the panel's (any Enter, as
      // before: Cmd+Enter picks rather than sending under the open panel), and an input method's Enter still
      // confirms its candidate
      const move = isEnter(e) ? (e.repeat ? null : 'pick') : listKey(e, true);
      if (move === 'next') {
        e.preventDefault();
        setIdx((i) => Math.min(i + 1, all.length - 1));
      } else if (move === 'prev') {
        e.preventDefault();
        setIdx((i) => Math.max(i - 1, 0));
      } else if (move === 'pick') {
        e.preventDefault();
        if (all[idx]?.disabled) return;
        all[idx]?.run();
        a.close();
      }
    };
    window.addEventListener('keydown', h, true);
    return () => window.removeEventListener('keydown', h, true);
  });
  return (
    <>
      <Tooltip label="Add files and more">
        <button
          ref={a.ref}
          className={`composer-icon-btn add ${a.open ? 'active' : ''}`}
          onClick={a.toggle}
          aria-label="Add files and more"
        >
          <Plus size={18} strokeWidth={1.8} />
        </button>
      </Tooltip>
      <Popover anchor={composerEl} open={a.open} onClose={a.close} placement="top-start" offset={4} matchWidth>
        <div className="add-panel">
          <div className="add-panel-label">Add</div>
          {all.map((it, i) => (
            <div key={it.key}>
              {it.plugin && !all[i - 1]?.plugin && <div className="add-panel-label">Plugins</div>}
              <button
                className={`add-panel-item ${i === idx ? 'sel' : ''} ${it.disabled ? 'disabled' : ''}`}
                aria-disabled={!!it.disabled}
                title={it.disabled}
                onMouseMove={() => setIdx(i)}
                onClick={() => {
                  if (it.disabled) return;
                  it.run();
                  a.close();
                }}
              >
                <span className="add-panel-icon">{it.icon}</span>
                <span className="add-panel-title">{it.title}</span>
                {it.desc && <span className="add-panel-desc">{it.desc}</span>}
                {it.key === 'plan' && planMode && <Check size={14} className="add-panel-check" />}
              </button>
            </div>
          ))}
          {pluginsFailed && (
            <>
              <div className="add-panel-label">Plugins</div>
              <div className="add-panel-error" role="alert">
                Couldn't list your plugins: {pluginsFailed}
              </div>
            </>
          )}
        </div>
      </Popover>
      <ProjectMenu anchor={a.anchor} open={proj.open} onClose={proj.close} placement="top-start" />
      {sketch && <SketchPad onClose={() => setSketch(false)} onInsert={onSketch} />}
      {share && <ComputerHistoryShare cap={historyCap} onAttach={onAttach} onClose={() => setShare(false)} />}
      {recording && <RecordSkill threadId={threadId} onClose={() => setRecording(false)} />}
    </>
  );
}

/* ------------------------------------------------------------------ */
/* Permission picker                                                   */
/* ------------------------------------------------------------------ */
export { permissionIcon };

/** A basic harness's modes take the permission slot (harnessPicker/ModePicker.tsx). */
export { ModePicker };

/** Codex's and Claude Code's permission modes; a basic harness has its own (ModePicker). */
export function PermissionPicker({ threadId, harness }: { threadId: string | null; harness: HarnessId }) {
  const mode = useChatPermission(threadId);
  const next = useStore((s) => effectivePermission(threadId ? s.chatConfig[threadId] : null, s.prefs.permission));
  // "Approve for me" only where the model can auto-approve (Claude's supportsAutoMode, D-67)
  const noAuto = useEffectiveSelection(harness, threadId).model?.autoMode === false;
  const a = useAnchor();
  useEffect(() => {
    // the shortcut, /permissions and a blocked step's "Change mode" reach the focused pane's composer alone
    const h = (event: Event) => {
      if (ownsComposerCommand(event, a.anchor)) a.setOpen(true);
    };
    window.addEventListener('open-permission-picker', h);
    return () => window.removeEventListener('open-permission-picker', h);
  }, [a]);
  const menu = permissionMenu(harness);
  const cur = menu.rows.find((p) => p.id === mode) ?? menu.rows[1];
  return (
    <>
      <Tooltip label="Change permissions">
        <button ref={a.ref} className={`perm-btn ${mode} ${a.open ? 'active' : ''}`} onClick={a.toggle} aria-label="Change permissions">
          {permissionIcon(mode === 'plan' ? 'read-only' : cur.id, 15)}
          <span>{mode === 'plan' ? 'Plan mode' : cur.label}</span>
        </button>
      </Tooltip>
      <Popover anchor={a.anchor} open={a.open} onClose={a.close} placement="top-start">
        <div className="menu perm-menu" style={{ width: 460 }}>
          <div className="perm-menu-head">
            <span>{menu.title}</span>
            <WebLink href={menu.learnMore}>Learn more</WebLink>
          </div>
          {mode === 'plan' && <p className="perm-mode-note">{PLAN_PERMISSION_HINT}</p>}
          {mode !== 'plan' && mode !== next && (
            <p className="perm-mode-note">{next === 'plan' ? 'Plan mode' : PERMISSION_LABEL[next]} applies to your next message.</p>
          )}
          <MenuList className="perm-list" label={menu.title}>
            {menu.rows.map((p) => (
              <MenuRow
                key={p.id}
                className={`has-desc perm-item ${p.id} ${noAuto && p.id === 'auto-review' ? 'disabled' : ''}`}
                role="menuitemradio"
                aria-checked={p.id === mode}
                // not for this model: the keyboard skips it and a click says why
                aria-disabled={noAuto && p.id === 'auto-review'}
                title={noAuto && p.id === 'auto-review' ? "This model can't auto-approve · Switch model" : undefined}
                onClick={() => {
                  if (noAuto && p.id === 'auto-review') return toast("This model can't auto-approve · Switch model");
                  setPrefs({ permission: p.id });
                  if (threadId) setChatConfig(threadId, { permission: p.id });
                  a.close();
                }}
              >
                <span className="menu-icon">{permissionIcon(p.id, 18)}</span>
                <span className="menu-label">
                  <span className="menu-title">{p.label}</span>
                  <span className="menu-desc">{p.detail}</span>
                </span>
                <span className="menu-check">{p.id === mode ? <Check size={16} strokeWidth={2} /> : null}</span>
              </MenuRow>
            ))}
          </MenuList>
        </div>
      </Popover>
    </>
  );
}
