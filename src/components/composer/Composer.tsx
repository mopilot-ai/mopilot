// The message composer: text and attachments, mentions and slash commands, the harness, model and mode
// pickers, and sending. Its slash commands, menus and bars are in the Composer*.tsx modules beside it.

import { useComposerText } from './useComposerText';
import { useDraftRestore } from './useDraftRestore';
import { QueuedList } from './QueuedList';
import { useContext, useEffect, useRef, useState } from 'react';
import { composerSlashItems } from '../../lib/composerSkills';
import { useStore, setDraft, toast, toastFailure, get as getState, threadTitle } from '../../store/core';
import { sendMessage, giveBackToComposer, loadCloudTasks } from '../../store/send';
import { navigate } from '../../store/panes';
import { sessionToken } from '../../lib/sessionMentions';
import { useComposerReferences } from './useComposerReferences';
import { withChatReferences } from '../../../shared/chatReferences.mjs';
import { acpRegistry, acpTyped, basicLabel } from '../../session/harness/acp';
import { whyText } from '../../harness/caps';
import { ModelPicker } from '../harnessPicker/HarnessPicker';
import { ContextRing } from './ContextRing';
import { RoutingChip } from './RoutingChip';
import { goalOff } from '../../session/harness/goalCommand';
import { parseGoalCommand } from '../../lib/codexGoals';
import { composerFamily } from '../../session/harness/select';
import { useComposerHarness } from '../../session/useComposerHarness';
import { useMachineMenu } from './machineSlashItems';
import { activityUx } from '../../session/activityUx';
import { StartingChat, type StartingChatProps } from '../thread/StartingChat';
import { useClaudeCommands, useCommandProvider } from '../../session/harness/claude';
import { composeCommands, resolveTyped } from '../../harness/commands';
import { useCap, useCaps } from '../../store/session/useCaps';
import { copy } from '../../harness/copy';
import { parseBang } from '../../harness/polyfills/shell';
import { codexAttachBlocked } from '../../harness/entries';
import { native } from '../../lib/native';
import { useComposerPlan, planCommandOff } from './useComposerPlan';
import { errorText, ignoring } from '../../lib/ignored';
import { useComposerAttachments } from './useComposerAttachments';
import { ComposerDictation } from '../momo/ComposerDictation';
import { ComposerVoice } from './ComposerVoice';
import { prepareAudioSubmission } from '../../session/audioSubmission';
import { ComposerAttachments } from './ComposerAttachments';
import { useSelectionAttachments } from './useSelectionAttachments';
import { useComposerDraft } from './useComposerDraft';
import { useComposerSpeech } from './useComposerSpeech';
import { composerGoalMessage, composerGoalReason } from '../../harness/composerGoalMessage';
import { expandPageAnnotations } from '../../lib/pageAnnotations';
import type { Attachment, Thread } from '../../store/types';
import { ComposerInput, type ComposerInputElement } from './ComposerInput';
import { useSendMorph } from '../../lib/sendMorph';
import { MentionPopup, SlashPopup, useComposerPopup, type SlashItem } from './ComposerPopups';
import { Tooltip } from '../ui/Popover';
import { Square, Spinner } from '../ui/icons';
import { SendButton } from './SendButton';
import { useSendBlock } from '../../session/useHostSigninNeed';
import { StatusStrip } from '../thread/StatusStrip';
import { useNextStep } from './useNextStep';
import { acceptsNextStep } from '../../lib/nextStep';
import { recordPrompt } from '../../lib/promptHistory';
import { useComposerHistory } from './useComposerHistory';
import { composerSendIntent, composerSendShortcuts } from '../../lib/composerSendKeys';
import { imeComposing } from '../../lib/focus';
import { ComposerStrips } from './ComposerStrips';
import type { BrowserTabOption } from './BrowserTabMentions';
import { tabToken } from '../../../shared/tabMentions.mjs';
import { NextMessageChip } from './NextMessageChip';
import { useSessionField } from '../../store/session/useSession';
import { composerFields } from './ComposerCommands';
import { isRunningTask } from '../../lib/tasks';
import { useComposerStop } from './useComposerStop';
import { useSlashPick } from './useSlashPick';
import { blocked, type SlashCommand, SLASH_COMMANDS, runBang, remoteOffWhy, useSlashItems, useChatFolderHere } from './ComposerSlash';
import { usePluginSlashItems } from '../../session/harness/pluginSkills';
import { AttachMenu } from './ComposerMenus';
import { ComposerModeChips } from './ComposerModeChips';
import { MomoModel, MomoPlaceholder, useMomoChat } from '../momo/useMomoChat';
import { momoMenu, momoNames, momoTypedAsText } from '../../../shared/momoCommands.mjs';
import { ContextBar, FullAccessBanner, VoiceBar } from './ComposerBars';

export { permissionIcon } from './ComposerMenus';

/* ------------------------------------------------------------------ */
/* Composer                                                            */
/* ------------------------------------------------------------------ */
export function Composer({ threadId, variant, inPane = false }: { threadId: string | null; variant: 'home' | 'thread'; inPane?: boolean }) {
  const draftKey = threadId ?? 'home';
  const draft = useStore((s) => s.drafts[draftKey]);
  const running = useStore((s) => (threadId ? !!s.runtime[threadId]?.activeTurnId : false));
  const prefs = useStore((s) => s.prefs);
  // plan mode and a pending switch are the chat's (main's SessionState): an approval card or a second window keeps them
  const session = useSessionField(threadId, composerFields);
  const { harness, basic, hint, acpCommands } = useComposerHarness(threadId);
  // a MoMo chat's composer has none of the coding side's chrome (#2279): no mode or access picker, project or goal; MoMo's own control in the model picker's slot
  const [momo, momoPlaceholder] = [useMomoChat(threadId), useContext(MomoPlaceholder)];
  const [slashNote, setSlashNote] = useState<{ note: string; text: string } | null>(null);
  const cloudCap = useCap(threadId, 'cloud', hint).state === 'native';
  // !cmd runs on this Mac through MoPilot where the harness has no shell of its own
  const bangByMoPilot = useCap(threadId, 'shell', hint).state === 'sage';
  const [text, setText] = useState(draft?.text ?? '');
  const [goalMode, setGoalMode] = useState(draft?.goal ?? false);
  const [attachments, setAttachments] = useState<Attachment[]>(draft?.attachments ?? []);
  const [dragOver, setDragOver] = useState(false);
  const { planMode, setPlanMode, planOffWhy } = useComposerPlan(threadId, session.plan, { harness, basic });
  const taRef = useRef<ComposerInputElement>(null);
  const currentDraftKey = useRef(draftKey);
  currentDraftKey.current = draftKey;
  const currentDraftOptions = useRef({ attachments, goalMode, planMode });
  currentDraftOptions.current = { attachments, goalMode, planMode };
  const boxRef = useRef<HTMLDivElement>(null);
  const { addFiles, pickFiles, addSketch, onPaste, setIncoming, admit, attachmentOff } = useComposerAttachments({
    draftKey,
    currentDraftKey,
    taRef,
    setAttachments,
    attachments,
    threadId,
  });
  const speech = useComposerSpeech(threadId, draftKey, boxRef, taRef, setText);
  const { preparingReferences, prepareReferences } = useComposerReferences(
    { threadId, text, attachments, goalMode, planMode, kind: hint?.kind ?? null, cloudCap },
    taRef,
  );
  const { voiceHere, voiceOn, dictationControl, ownerKey } = speech;
  const [submission, setSubmission] = useState<(StartingChatProps & { draftKey: string }) | null>(null);
  const submissionRef = useRef(submission);
  const starting = submission?.draftKey === draftKey ? submission : null;
  const { popup, setPopup, popupIndex, setPopupIndex, updatePopup, markApplied } = useComposerPopup();
  const history = useComposerHistory(threadId, text, setText);
  const chatCwd = useChatFolderHere(threadId);
  const nativeCmds = useClaudeCommands(threadId, chatCwd);
  // typing and the / menu both read this provider (Claude's catalog or Codex's table)
  const provider = useCommandProvider(threadId, chatCwd);
  // commands the harness can't do at all stay out of the menu; the footer says so
  const chatCaps = useCaps(threadId, hint);
  const hiddenCommands = nativeCmds ? composeCommands(nativeCmds, chatCaps as never).hidden.length > 0 : false;
  // finished tasks stay in the list (the Background tasks tab shows them): only running ones count
  const liveTasks = session.tasks.filter((t) => !t.ambient && isRunningTask(t));
  const { confirmStopAll, setConfirmStopAll, stopTurn, onStopKey } = useComposerStop(threadId, running, liveTasks.length, taRef);

  const { main, takesFocus } = useComposerText(threadId, inPane, setText, setAttachments, taRef);
  useDraftRestore(draftKey, taRef, takesFocus, setText, setGoalMode, setAttachments, setPopup);

  useComposerDraft(draftKey, text, attachments, setDraft, goalMode);

  useSelectionAttachments(threadId, setIncoming, taRef, admit);

  // another app is running a turn on this chat: nothing can be sent until it finishes
  const lockedOut = !!threadId && session.runningElsewhere;
  // the chat's PeerMessages opens its compose dialog, with the recipient preselected ('' lets the user choose)
  const peerCompose = threadId
    ? (targetChatId: string) =>
        window.dispatchEvent(new CustomEvent('mopilot:peer-compose', { detail: { sourceChatId: threadId, targetChatId } }))
    : undefined;
  // after a turn that used browser or desktop control: one suggested follow-up, as the placeholder
  const nextStep = useNextStep(threadId);
  const sendKeys = composerSendShortcuts(prefs.sendWith);
  const queuesFollowUps = !!basic || prefs.followUp === 'queue';
  const sendHint = basic ? `${sendKeys.send} to queue for later` : `${sendKeys.send} to send, ${sendKeys.queue} to queue for later`;
  // a temporary chat can't have a goal: the Goal entries are greyed with the reason (D-49)
  const goalSessionOff = useStore((s) => goalOff(threadId, s));
  const goalOffWhy = composerGoalReason(chatCaps.goal, goalSessionOff);
  const sendBlock = useSendBlock(threadId, harness ?? basic);
  const canSend =
    !lockedOut &&
    !preparingReferences &&
    !starting &&
    (goalMode ? text.trim().length > 0 : text.trim().length > 0 || attachments.length > 0);
  // the round button morphs between send, stop and voice as the Codex composer's does (composer.css)
  const voiceChat = !momo && chatCaps.voiceChat?.state === 'native'; // else the empty composer keeps a disabled Send
  const { morph, onAnimationEnd: morphEnd } = useSendMorph(running && !canSend ? 'stop' : canSend || !voiceChat ? 'send' : 'voice');
  const selectGoal = () => {
    if (blocked(threadId, 'goal')) return;
    setGoalMode(true);
    setPopup(null);
    requestAnimationFrame(() => taRef.current?.focus());
  };

  /**
   * Input that didn't go out (main refused the send, or the command failed) goes back where it was typed, in this
   * box or in its chat's saved draft, unless something new was typed there meanwhile. `goal` says whether it was a
   * goal; left out, the box keeps its goal mode.
   */
  const giveBack = (value: string, atts: Attachment[], goal?: boolean) => {
    const saved = getState().drafts[draftKey];
    if (!saved) return;
    const active = currentDraftKey.current === draftKey && !!taRef.current;
    if (active) {
      if (taRef.current!.value || currentDraftOptions.current.attachments.length) return;
      setText(value);
      setAttachments(atts);
      if (goal !== undefined) setGoalMode(goal);
    } else if (saved.text || saved.attachments.length) return;
    setDraft(draftKey, {
      ...saved,
      text: value,
      attachments: atts,
      goal: goal ?? (active ? currentDraftOptions.current.goalMode : saved.goal),
    });
  };

  // A completed local command that takes text uses or drops its attachments, one that takes none leaves them with the
  // text; a failed or refused one (it resolves false: a send main didn't take, which already said why) retains its draft.
  const runIntercepted = async (cmd: SlashCommand, args: string) => {
    // a command that takes no text (/plan, /model) uses its line alone: what was typed after it stays in the box
    const rest = cmd.takesText ? '' : args.trim();
    if (rest) {
      setPopup(null);
      setText(rest);
      setDraft(draftKey, { text: rest, attachments });
      return runPopupCommand(() => cmd.run({ threadId, args: '' }), rest);
    }
    setText('');
    setPopup(null);
    setAttachments([]);
    setDraft(draftKey, { text: '', attachments: [] });
    try {
      if ((await cmd.run({ threadId, args })) === false) giveBack(text, attachments);
    } catch (e) {
      toast(errorText(e), 'error');
      giveBack(text, attachments);
    }
  };

  // /plan typed is the composer's own mode switch, the / menu's Plan mode entry; a MoMo chat runs MoMo's commands alone
  const commandNamed = (typed: string[], names = momoNames(momo, typed)): SlashCommand | undefined =>
    names.includes('plan') ? { name: 'plan', run: () => setPlanMode(!planMode) } : SLASH_COMMANDS.find((c) => names.includes(c.name));

  const { runPopupCommand, putCommand, pick } = useSlashPick({
    draftKey,
    text,
    attachments,
    setText,
    closePopup: () => setPopup(null),
    input: taRef,
    currentKey: currentDraftKey,
    currentOptions: currentDraftOptions,
  });

  const submit = async (o?: { raw?: boolean; steer?: boolean }) => {
    const value = text;
    if (!canSend || sendBlock) return;
    if (goalMode && goalOffWhy) return toast(goalOffWhy, 'error');
    if (goalMode && blocked(threadId, 'goal')) return;
    setSlashNote(null);
    const raw = o?.raw === true || (momo && momoTypedAsText(value));
    if (basic && !raw && !goalMode) {
      const r = acpTyped(value, basic, acpCommands);
      if (r.kind === 'blocked') return toast(`/${r.name} isn't sent. Close the chat instead.`);
      // the harness pushed a command list and this isn't on it
      if (r.kind === 'unknown') return setSlashNote({ note: r.note.replace(/\s*·[^·]*$/, ''), text: value });
      if (r.kind === 'disabled' || r.kind === 'hidden')
        return toast(whyText(r.why, { label: basicLabel(basic), semantic: r.command.semantic }));
      if (r.kind === 'ui' || r.kind === 'rpc' || r.kind === 'polyfill') {
        const names = [r.command.name, ...(r.command.aliases ?? [])];
        const cmd = commandNamed(names);
        if (cmd?.needsThread && !threadId) return toast(`/${cmd.name} needs an open chat`);
        if (cmd) await runIntercepted(cmd, r.args);
        return;
      }
    }
    // slash command?
    const sm = basic || goalMode ? null : /^\/([\w-]+)(?:\s+([\s\S]*))?$/.exec(value.trim());
    // Native commands pass through; goals, init and compaction keep their shared action handling.
    const typed = provider && sm ? resolveTyped(value, composeCommands(provider)) : null;
    if (typed && !raw) {
      if (attachmentOff && 'command' in typed && typed.command?.source === 'skill') return toast(attachmentOff);
      if (typed.kind === 'blocked') return toast(`/${typed.name} isn't sent. Close the chat instead.`);
      if (typed.kind === 'unknown') return setSlashNote({ note: typed.note.replace(/\s*·[^·]*$/, ''), text: value });
      if (typed.kind === 'disabled' || typed.kind === 'hidden')
        return toast(whyText(typed.why, { label: provider!.label, semantic: typed.command.semantic }));
    }
    const passthrough = typed?.kind === 'passthrough' && !!typed.command && typed.command.name !== 'goal' && typed.command.name !== 'init';
    if (sm && !passthrough && !raw) {
      // an alias (/clear) runs its command's handler
      const name = typed && (typed.kind === 'ui' || typed.kind === 'rpc' || typed.kind === 'polyfill') ? typed.command.name : sm[1];
      const cmd = commandNamed([name]);
      if (cmd) {
        if (cmd.needsThread && !threadId) {
          toast(`/${cmd.name} needs an open chat`);
          return;
        }
        // the typed text stays in the box
        if (cmd.name === 'goal' && goalOffWhy && parseGoalCommand(sm[2] ?? '').kind === 'set') return toast(goalOffWhy, 'error');
        await runIntercepted(cmd, sm[2] ?? '');
        return;
      }
    }
    const bang = bangByMoPilot && !basic && !momo && !raw && !goalMode ? parseBang(value) : null;
    if (bang) {
      recordPrompt(threadId, value);
      setText('');
      setAttachments([]);
      setDraft(draftKey, { text: '', attachments: [] });
      setPopup(null);
      // the command line goes back when its output didn't go out
      if ((await runBang(threadId, bang.cmd)) === false) giveBack(value, attachments);
      return;
    }
    const prepared = await prepareReferences();
    if (!prepared?.isCurrent()) return;
    const { refs, cloudEnv } = prepared;
    // Two Enter events can prepare references before React paints the disabled composer.
    if (submissionRef.current?.draftKey === draftKey) return;
    recordPrompt(threadId, value);
    // a browser page-annotation chip goes out as its image plus its text, which every harness takes
    const atts = expandPageAnnotations([...attachments.filter((a) => a.kind !== 'session'), ...refs]);
    let goal: ReturnType<typeof composerGoalMessage> | null = null;
    // a goal this chat can't send as written (a text-only goal with files): say why, and keep everything as typed
    if (goalMode)
      try {
        goal = composerGoalMessage(chatCaps.goal, value, atts);
      } catch (e) {
        return toast(errorText(e), 'error');
      }
    const attempt =
      (!threadId && !cloudEnv) || atts.some((a) => a.kind === 'audio')
        ? { draftKey, text: value, attachments, ux: activityUx(composerFamily(threadId)) }
        : null;
    if (attempt) {
      submissionRef.current = attempt;
      setSubmission(attempt);
    }
    let audioTransfer: string | null | undefined;
    try {
      if (atts.some((a) => a.kind === 'audio'))
        audioTransfer = await prepareAudioSubmission(draftKey, value, atts, threadId, hint, prepared.isCurrent);
    } catch (e) {
      submissionRef.current = null;
      setSubmission(null);
      return toastFailure("Couldn't retain audio message")(e);
    }
    if (audioTransfer === null) {
      submissionRef.current = null;
      setSubmission(null);
      return;
    }
    setText('');
    setAttachments([]);
    setGoalMode(false);
    setDraft(draftKey, { text: '', attachments: [] });
    setPopup(null);
    const sentAttachments = attachments;
    try {
      if (goal) {
        if (
          (await sendMessage(threadId, goal.text, goal.attachments, { ...goal.options, ...(audioTransfer ? { audioTransfer } : {}) })) ===
          false
        )
          giveBack(value, sentAttachments, true);
        return;
      }
      if (!threadId && cloudEnv) {
        toast(`Starting cloud task in ${cloudEnv.label}…`);
        const r = await prepared.launchCloud(cloudEnv.id, withChatReferences(value, refs));
        if (!r.ok || !r.id) {
          giveBack(value, sentAttachments, false);
          return toast(r.output.split('\n').pop() || 'Could not start cloud task', 'error');
        }
        // cannot reject: loadCloudTasks records a list it couldn't read and keeps the last one
        void loadCloudTasks();
        return navigate({ name: 'cloud', id: r.id });
      }
      if (
        (await sendMessage(threadId, value, atts, {
          plan: planMode,
          human: true,
          ...(o?.steer !== undefined ? { steer: o.steer } : {}),
          ...(audioTransfer ? { audioTransfer } : {}),
        })) === false
      )
        giveBack(value, sentAttachments, false);
    } catch (e) {
      toastFailure("Couldn't send")(e);
      giveBack(value, sentAttachments, !!goal);
    } finally {
      if (audioTransfer) void native.speech.finishTransfer(audioTransfer, true).catch(ignoring('retire a prepared audio transfer'));
      if (attempt) {
        submissionRef.current = null;
        setSubmission(null);
      }
    }
  };

  // the send button and Enter: whatever submit didn't handle itself is a toast, not a click that did nothing
  const send = (o?: { raw?: boolean; steer?: boolean }) => {
    submit(o).catch(toastFailure("Couldn't send"));
  };

  // "/usage" typed in full is the harness's own command: Enter sends it rather than picking from the menu (D-20)
  const exactNative = () => {
    if (!nativeCmds || popup?.kind !== 'slash' || popup.skillsOnly || !/^\/[\w-]+$/.test(text.trim())) return false;
    const typed = resolveTyped(text, composeCommands(nativeCmds));
    if (typed.kind === 'rpc') return typed.command.semantic === 'compact';
    return typed.kind === 'passthrough' && !!typed.command && typed.command.name !== 'goal' && typed.command.name !== 'init';
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    // keys while an input method is composing (Japanese, Chinese…) are the IME's: Enter confirms a candidate
    if (imeComposing(e)) return;
    if (popup) {
      if (e.key === 'Escape') {
        e.preventDefault();
        setPopup(null);
        return;
      }
      if (
        e.key === 'ArrowDown' ||
        e.key === 'ArrowUp' ||
        e.key === 'Tab' ||
        (e.key === 'Enter' && !e.shiftKey && !e.altKey && !e.metaKey && !e.ctrlKey && !exactNative())
      ) {
        const ev = new CustomEvent('composer-popup-key', {
          detail: { key: e.key === 'Tab' ? 'Enter' : e.key, owner: boxRef.current },
          cancelable: true,
        });
        window.dispatchEvent(ev);
        if (ev.defaultPrevented) {
          e.preventDefault();
          return;
        }
      }
    }
    if (acceptsNextStep(e, text, nextStep) && !attachments.length) {
      e.preventDefault();
      setText(nextStep);
      return;
    }
    if (onStopKey(e)) return;
    const intent = composerSendIntent(e, prefs.sendWith);
    if (intent) {
      e.preventDefault();
      send(running && !goalMode ? { steer: intent === 'steer' } : undefined);
      return;
    }
    history.onKey(e, !text && !attachments.some((a) => a.kind === 'skill'));
  };

  // "Try now" from the Skills page attaches the skill to the new-chat composer.
  useEffect(() => {
    if (threadId) return;
    const h = (e: Event) => {
      const d = (e as CustomEvent).detail;
      if (attachmentOff) return toast(attachmentOff);
      const no = codexAttachBlocked(harness);
      if (no) return toast(no);
      setIncoming((a) => [...a, { kind: 'skill', name: d.name, path: d.path, displayName: d.displayName }]);
      taRef.current?.focus();
    };
    // "Try now" on a plugin page attaches the plugin mention.
    const m = (e: Event) => {
      const d = (e as CustomEvent).detail;
      if (attachmentOff) return toast(attachmentOff);
      const no = codexAttachBlocked(harness);
      if (no) return toast(no);
      setIncoming((a) => (a.some((x) => x.path === d.path) ? a : [...a, { kind: 'file', name: d.name, path: d.path }]));
      taRef.current?.focus();
    };
    window.addEventListener('insert-skill', h);
    window.addEventListener('insert-mention', m);
    return () => {
      window.removeEventListener('insert-skill', h);
      window.removeEventListener('insert-mention', m);
    };
  }, [threadId, harness, setIncoming, attachmentOff]);
  const slashItems = useSlashItems(
    threadId,
    planMode,
    setPlanMode,
    (t) => {
      // the draft stays: goal mode makes it the objective
      if (t === '/goal ') return selectGoal();
      putCommand(t);
    },
    (name, path, displayName) => {
      setIncoming((a) => [...a, { kind: 'skill', name, path, displayName }]);
    },
    { goalOffWhy, planOffWhy, attachmentOff, remoteOffWhy: remoteOffWhy(chatCaps), cloudCap },
  );
  // a basic harness's / menu: Sage's UI commands, then the commands the harness listed
  const basicSlashItems: SlashItem[] = basic
    ? acpRegistry(basic, acpCommands).menu.map((c) => ({
        id: `acp:${c.name}`,
        title: `/${c.name}`,
        desc: c.description,
        disabled: c.name === 'goal' ? (goalOffWhy ?? undefined) : planCommandOff(c, planOffWhy),
        scope: c.dispatch === 'passthrough' ? basicLabel(basic) : undefined,
        run: () => {
          if (c.name === 'goal') return selectGoal();
          const cmd = c.dispatch === 'passthrough' ? null : commandNamed([c.name]);
          if (cmd) return cmd.run({ threadId, args: '' });
          putCommand(`/${c.name} `);
        },
      }))
    : [];
  basicSlashItems.push(...usePluginSlashItems(!attachmentOff && basic ? 'acp' : null, setIncoming));
  const menu = useMachineMenu(threadId, popup?.kind === 'slash', putCommand, basic ? basicSlashItems : slashItems, !!basic, attachmentOff);
  // the mention list only shows (and picks) while its popup is open, so `popup` is set here
  const applyMention = (path: string, isDir: boolean) => {
    const token = `@${path}${isDir ? '/' : ''} `;
    markApplied(token);
    taRef.current!.replaceRange(popup!.start, taRef.current!.selectionStart, token);
    setPopup(null);
  };
  const applyChatMention = (thread: Thread) => {
    const token = sessionToken(thread.id, threadTitle(thread)) + ' ';
    taRef.current!.replaceRange(popup!.start, taRef.current!.selectionStart, token);
    setPopup(null);
  };
  // a browser tab from the @ menu: a chip each harness adapter serializes on send (shared/tabMentions.mjs)
  const applyTabMention = (start: number, tab: BrowserTabOption) => {
    taRef.current!.replaceRange(start, taRef.current!.selectionStart, tabToken(tab) + ' ');
    setPopup(null);
  };

  return (
    <div className={`composer-wrap v-${variant}`} data-composer-chat={threadId ?? ''} data-composer-main={main}>
      {starting && <StartingChat {...starting} />}
      {variant === 'home' && <ContextBar />}
      <ComposerStrips threadId={threadId} agent={harness ?? basic} />
      {threadId && <StatusStrip threadId={threadId} approval={false} confirm={confirmStopAll} setConfirm={setConfirmStopAll} />}
      {variant === 'thread' && !momo && <FullAccessBanner threadId={threadId} harness={harness} basic={basic} />}
      {threadId && <QueuedList threadId={threadId} onEdit={(q) => giveBackToComposer(threadId, q.text, q.attachments, true)} />}
      <div
        ref={boxRef}
        className={`composer ${dragOver ? 'drag-over' : ''}`}
        onDragOver={(e) => {
          e.preventDefault();
          setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragOver(false);
          const paths = [...e.dataTransfer.files].map((f) => native.fs.pathForFile(f)).filter(Boolean);
          // cannot reject: a preview that can't be read is left out, not the file
          void addFiles(paths);
        }}
        onMouseDown={(e) => {
          if ((e.target as HTMLElement).closest('button, a, .attachment, textarea, input, [contenteditable], .selection-pop')) return;
          e.preventDefault();
          taRef.current?.focus();
        }}
      >
        <ComposerAttachments attachments={attachments} onChange={setAttachments} onFocus={() => taRef.current?.focus()} />
        <NextMessageChip threadId={threadId} />
        {!threadId && <RoutingChip />}
        {slashNote && slashNote.text === text && (
          <div className="slash-note" role="status">
            <span>{slashNote.note}</span>
            <button className="btn-pill" onClick={() => send({ raw: true })}>
              Send as plain text
            </button>
          </div>
        )}
        {history.position && (
          <div className="composer-history" role="status">
            History {history.position.n}/{history.position.total}
          </div>
        )}
        {voiceHere && <VoiceBar />}
        <ComposerInput
          ref={taRef}
          onSessionOpen={(id) => navigate({ name: 'thread', id })}
          onSessionSend={peerCompose}
          value={text}
          attachments={attachments}
          hidden={voiceOn}
          placeholder={
            lockedOut ? RUNNING_ELSEWHERE : (nextStep ?? (running && !goalMode ? sendHint : momo ? momoPlaceholder : 'Do anything'))
          }
          disabled={lockedOut || preparingReferences || !!starting}
          onChange={(value, nextAttachments, caret) => {
            setText(value);
            setAttachments(nextAttachments);
            setSlashNote(null);
            updatePopup(value, caret);
          }}
          onKeyDown={onKeyDown}
          onPaste={onPaste}
          onSelect={updatePopup}
        />
        <div className="composer-footer">
          <div className="composer-left">
            <AttachMenu
              composerEl={boxRef.current}
              harness={harness}
              attachmentOff={attachmentOff}
              onSketch={addSketch}
              onPickFiles={pickFiles}
              onMention={(name, path) => setIncoming((a) => [...a, { kind: 'file', name, path }])}
              goalOff={goalOffWhy}
              onGoal={selectGoal}
              planMode={planMode}
              planOff={planOffWhy}
              setPlanMode={setPlanMode}
              onMessageChat={peerCompose && (() => peerCompose(''))}
              historyCap={chatCaps.computerHistory}
              onAttach={(att) => setIncoming((a) => [...a.filter((x) => x.kind !== att.kind), att])}
              threadId={threadId}
              momo={momo}
              onAudioMessage={chatCaps.audioInput?.state === 'native' ? () => void dictationControl.current?.audio() : undefined}
            />
            <ComposerModeChips
              {...{ threadId, basic, harness, goalMode, planMode }}
              onClearGoal={() => {
                setGoalMode(false);
                taRef.current?.focus();
              }}
              onClearPlan={() => setPlanMode(false)}
            />
          </div>
          <div className="composer-right">
            {momo ? <MomoModel /> : <ModelPicker threadId={threadId} />}
            <ContextRing selection={hint?.kind ?? null} threadId={threadId} momo={momo} />
            <ComposerDictation
              key={ownerKey}
              threadId={threadId}
              hint={hint}
              control={dictationControl}
              onText={speech.insertText}
              onAudio={(a) => setIncoming((x) => [...x, a])}
            />
            <ComposerVoice
              speech={speech}
              available={voiceChat}
              pending={!!starting}
              compact={!!starting || running || canSend}
              morph={morph ?? undefined}
              onAnimationEnd={morphEnd}
            />
            {starting ? (
              <button className="send-btn" disabled aria-label="Starting chat">
                <Spinner size={16} />
              </button>
            ) : running && !canSend ? (
              <Tooltip
                label={
                  liveTasks.length
                    ? 'Stop this turn and pause the goal · Background tasks keep running (press Esc again to stop all)'
                    : 'Stop'
                }
                shortcut="Esc"
              >
                <button
                  className="send-btn stop"
                  data-morph={morph ?? undefined}
                  onAnimationEnd={morphEnd}
                  onClick={stopTurn}
                  aria-label="Stop"
                >
                  <Square size={11} fill="currentColor" strokeWidth={0} />
                </button>
              </Tooltip>
            ) : canSend ? (
              <SendButton
                label={running ? (queuesFollowUps ? 'Queue message' : 'Steer') : 'Send'}
                shortcut={running && !goalMode && queuesFollowUps ? sendKeys.queue : sendKeys.send}
                block={sendBlock}
                morph={morph}
                onAnimationEnd={morphEnd}
                onSend={() => {
                  send();
                  // a clicked button keeps the focus and the stop button replaces it: Esc and the next message go to the editor (#1658)
                  taRef.current?.focus();
                }}
              />
            ) : null}
          </div>
        </div>
        {popup?.kind === 'slash' && (
          <SlashPopup
            key={popup.skillsOnly ? 'skills' : 'commands'}
            anchor={boxRef.current}
            query={popup.query}
            index={popupIndex}
            setIndex={setPopupIndex}
            items={composerSlashItems(momoMenu(momo, menu), popup)}
            footer={!popup.skillsOnly && hiddenCommands ? copy('commands', 'someHidden') : undefined}
            onDone={(item) => pick(popup, item)}
            onClose={() => setPopup(null)}
          />
        )}
        {popup?.kind === 'mention' && (
          <MentionPopup
            anchor={boxRef.current}
            threadId={threadId}
            query={popup.query}
            index={popupIndex}
            setIndex={setPopupIndex}
            onPick={applyMention}
            onPickChat={applyChatMention}
            onPickTab={(tab) => applyTabMention(popup.start, tab)}
            onClose={() => setPopup(null)}
          />
        )}
      </div>
    </div>
  );
}
const RUNNING_ELSEWHERE = whyText({ layer: 'session', code: 'session.runningElsewhere' });
