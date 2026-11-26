// Starts a chat on the paired computer as Claude for iOS's new session page: Back, the spark and a serif greeting in the middle, chips for the agent, the computer and the project above the composer, and the composer with +, the model pill, dictation and send; it opens the chat like any chat.
import type { DraftHandle } from '../presentation/drafts';
import { useDraft } from '../presentation/useDraft';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useOwnedRequest } from '../remote/useOwnedRequest';
import { Keyboard, Text, View } from 'react-native';
import Animated, { useAnimatedStyle } from 'react-native-reanimated';
import type { MobileRuntime } from '../contracts';
import type { Media } from '../platform/media';
import { Button, ErrorLine, useStyles } from '../components/ui';
import { useTheme } from '../theme';
import { serifFamily } from '../fonts';
import { IMAGE_UPDATE } from '../remote/messageIdentity';
import { messagePictures, startReady } from '../presentation/messagePictures';
import type { FirstMessage } from '../presentation/sentMessages';
import { AttachmentStrip } from '../components/AttachmentStrip';
import { AddToSessionSheet } from '../components/AddToSessionSheet';
import { BottomSheet } from '../components/BottomSheet';
import { Chip, GlassCircle } from '../components/Glass';
import { ComposerBox, ComposerButton, ModelPill } from '../components/ComposerBox';
import { ComposerMenu } from '../components/ComposerMenu';
import { useComposerMenu } from '../remote/useComposerMenu';
import { popupAt } from '../remote/composerMenu';
import { Icon } from '../components/Icon';
import { Notice } from '../components/Notice';
import { PageHeader } from '../components/PageHeader';
import { Spark } from '../components/Spark';
import { VoiceNote } from '../components/VoiceNote';
import { AgentSheet, ComputerSheet, ModelSheet, ProjectSheet } from '../components/NewChatSheets';
import { CredentialNote, CredentialSheet, SignInChip } from '../components/CredentialSheet';
import { useCredentialPick } from '../remote/useCredentialPick';
import { FolderSheet, MachineSheet, ToneDot } from '../components/MachineSheets';
import { folderChip } from '../remote/folders';
import { useMachinePick } from '../remote/useMachinePick';
import { useMacLink } from '../macLink';
import { explain, loadOptions, loadStart, startChat, type Capabilities, type Harness, type Options, type Project } from '../remote/client';
import { useAttachments } from '../remote/useAttachments';
import { randomId } from '../platform/randomId';
import { lostInFlight, unconfirmedNotice } from '../remote/unconfirmed';
import { startMemory } from '../remote/startMemory';
import { useLastPicks } from '../remote/useLastPicks';
import { useHardwareBack } from '../useHardwareBack';
import { useKeyboardLift } from '../useKeyboardLift';
import { typo } from '../typography';

type Sheet = 'agent' | 'computer' | 'project' | 'folder' | 'model' | 'attach' | 'voice' | 'signin' | null;

/** "Back at it, Du": the first word of the account's name, or no name at all. */
export const greeting = (name: string | null | undefined) => {
  const first = name?.trim().split(/\s+/)[0];
  return first ? `Back at it, ${first}` : 'Back at it';
};

/** The project chip: its name and, when the Mac said, the branch its folder is on. */
export const projectChip = (project: Project | undefined, worktree: boolean) =>
  project ? [project.label, worktree ? 'new worktree' : project.branch].filter(Boolean).join(' · ') : 'No project';

export function NewChat({
  runtime,
  media,
  open,
  sending,
  back,
  drafts,
  focus = false,
}: {
  runtime: MobileRuntime;
  media: Media;
  /** The chat is started: open it, with what was sent (shown at once as your message) and the Mac's warning, if it gave one. */
  open: (chatId: string, sent: FirstMessage) => void;
  /** Start was tapped (the text) or the Mac refused or lost it (null): the app shows the chat's page over this one, which keeps its text, files and picks for a refusal. */
  sending: (text: string | null, startId?: string, pictures?: string[]) => void;
  back: () => void;
  /** The first message's draft, kept outside this screen for the app's lifetime, so a dropped connection that unmounts this screen does not lose it. */
  drafts: DraftHandle;
  /** The page opens with the keyboard up: a computer was just paired, and the first message is next. */
  focus?: boolean;
}) {
  const styles = useStyles();
  const theme = useTheme();
  const mac = useMacLink();
  const [sheet, setSheet] = useState<Sheet>(null);
  // Start was pressed on a Host with no folder: the Folder sheet opens, and the folder picked sends what was typed
  const [afterFolder, setAfterFolder] = useState(false);
  const lift = useKeyboardLift();
  const ride = useAnimatedStyle(() => ({ paddingBottom: lift.value }));
  const leave = () => {
    // leaving is looking: a start whose answer was lost is not offered again
    startMemory.clear(runtime);
    back();
  };
  // a sheet answers the back button itself; the page's own back is for when none is open
  useHardwareBack(leave, sheet === null);
  const request = useOwnedRequest(runtime);
  const [start, setStart] = useState<{
    harnesses: Harness[];
    projects: Project[];
    caps: Capabilities;
  } | null>(null);
  const [options, setOptions] = useState<Options | null>(null);
  // '' until the Mac has listed an agent
  const [harness, setHarness] = useState('');
  const [project, setProject] = useState<string | null>(null);
  const [model, setModel] = useState<string | null>(null);
  const [effort, setEffort] = useState<string | null>(null);
  const [permission, setPermission] = useState<string | null>(null);
  const [text, setText] = useDraft(drafts);
  const [account, setAccount] = useState<string | null>(null);
  const [worktree, setWorktree] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [optionsError, setOptionsError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // the chat may have been started as the connection went: starting again is safe (the same start id), but the list is looked at first
  const [unconfirmed, setUnconfirmed] = useState(() => startMemory.lost(runtime));
  const loads = useRef(0);
  const alive = useRef(true);
  const files = useAttachments(request);
  // where the chat runs: this Mac, or a Host the Mac lists (then its agents and a folder there)
  const where = useMachinePick(start?.harnesses ?? []);
  // the / and @ menus read this Mac's agent and project; a chat on another machine has no files or skills of this Mac's, so no menu there
  const menuOn = !!harness && !where.remote;
  // a chat on a machine: what it will use, and the person's pick of another source
  const { agent: machineAgent, machineName, using, choices, source, setSource } = useCredentialPick(where, harness);
  const menu = useComposerMenu(request, { harness, projectId: project }, menuOn ? text : '', setText);
  useEffect(() => {
    // an agent the picked machine does not have gives way to its first one that can run
    if (start && !where.harnesses.some((h) => h.id === harness && !h.unavailable))
      setHarness(where.harnesses.find((h) => !h.unavailable)?.id ?? '');
  }, [start, where.harnesses, harness]);
  const memory = useLastPicks(mac.pairId, where, { start, harness, options }, { setHarness, setModel, setEffort });
  useEffect(
    () => () => {
      alive.current = false;
    },
    [],
  );
  const begin = useCallback(() => {
    const mine = ++loads.current;
    setStart(null);
    setError(null);
    loadStart(request)
      .then((loaded) => {
        if (mine !== loads.current) return;
        setStart(loaded);
        setHarness(memory.harness(loaded.harnesses) ?? loaded.harnesses[0]?.id ?? '');
      })
      .catch((e) => {
        if (mine === loads.current) setError(explain(e));
      });
  }, [request, memory]);
  useEffect(() => {
    begin();
    return () => {
      ++loads.current;
    };
  }, [begin]);
  useEffect(() => {
    if (!start || !harness) return;
    let active = true;
    setOptions(null);
    setOptionsError(null);
    loadOptions(request, harness, start.caps.ceiling)
      .then((loaded) => {
        if (!active) return;
        setOptions(loaded);
        memory.apply(harness, loaded);
        // a Mac whose current permission the phone may not set leaves none picked: the most careful one it may use stands in, never the Mac's own
        setPermission(loaded.permission ?? loaded.permissions.find((p) => !p.disabled)?.id ?? null);
        setAccount(null);
      })
      .catch((e) => active && setOptionsError(explain(e)));
    return () => {
      active = false;
    };
  }, [request, start, harness, memory]);
  async function submit() {
    // the Start button is off while busy, so a start in flight is never asked for again
    if (!startReady(text, files.items, where.remote)) return;
    const pictures = messagePictures(files.items);
    if (where.remote && !where.folder) {
      setAfterFolder(true);
      setSheet('folder');
      return;
    }
    setBusy(true);
    setError(null);
    setUnconfirmed(false);
    let startId: string | undefined;
    // the chat's page opens now, with your message on it; the Mac's answer only says which chat it is
    try {
      // A Host receives explicit uploaded images, its folder and its own account; local project/worktree/skill references remain here.
      const picks = where.remote
        ? {
            harness,
            text,
            projectId: null,
            model,
            effort,
            permission,
            account: null,
            worktree: false,
            attachments: files.ids,
            hostId: where.host,
            folder: where.folder,
            ...(source ? { credential: { source } } : {}),
          }
        : {
            harness,
            text,
            projectId: project,
            model,
            effort,
            permission,
            account,
            worktree: worktree && !!project,
            attachments: files.ids,
            ...(menu.skills.length ? { skills: menu.skills } : {}),
          };
      // the same picks keep the same start id, so a retry after a lost answer (even after the screen was left and opened again) starts one chat; changed picks get a new one
      startId = startMemory.idFor(runtime, JSON.stringify([runtime.snapshot().user?.id, runtime.snapshot().selectedPair, picks]), randomId);
      const nativeId = pictures.length ? runtime.messageIdentity?.('chat.start', null, startId) : undefined;
      if (pictures.length && !nativeId) throw new Error(IMAGE_UPDATE);
      startMemory.retrying(runtime);
      sending(text, startId, pictures.length ? pictures : undefined);
      const { chatId, warning } = await startChat(request, {
        ...picks,
        startId,
      });
      startMemory.clear(runtime, startId);
      memory.remember({ harness, model, effort }, where.folder);
      if (!alive.current) return;
      // a warning is a line in the chat, never a reason to stay here
      open(chatId, { text, ...(pictures.length ? { id: startId, pictures, nativeId } : {}), ...(warning ? { warning } : {}) });
    } catch (e) {
      // back to this page, which still holds the text, files and picks
      if (alive.current) sending(null);
      // the connection going unmounts this screen: what it learned is kept for the next one
      const lost = lostInFlight(e);
      if (lost) startMemory.markLost(runtime, startId);
      if (alive.current) {
        if (lost) setUnconfirmed(true);
        else setError(explain(e));
        setBusy(false);
      }
    }
  }
  const ready =
    !!start &&
    !!harness &&
    !!options &&
    (options.permissions.length === 0 || !!permission) &&
    startReady(text, files.items, where.remote) &&
    !files.sending &&
    !busy;
  // the folder picked after Start was pressed starts the chat (with what this render holds); closing the sheet with none gives it up
  const submitNow = useRef(submit);
  submitNow.current = submit;
  useEffect(() => {
    if (!afterFolder) return;
    if (where.folder) {
      setAfterFolder(false);
      void submitNow.current();
    } else if (sheet !== 'folder') setAfterFolder(false);
  }, [afterFolder, where.folder, sheet]);
  const picked = options?.models.find((m) => m.id === model);
  const effortLabel = picked?.efforts.find((e) => e.id === effort)?.label;
  const status = !start
    ? error
      ? 'Could not load your computer’s options.'
      : 'Loading options from your computer…'
    : !start.harnesses.length
      ? 'No agent is ready on your computer. Set one up there, then try again.'
      : where.machine && where.remote && !where.harnesses.some((h) => !h.unavailable)
        ? // an offline machine has no agent to list because it cannot answer, not because none is set up
          where.machine.status === 'offline'
          ? `${where.machine.name} is offline.`
          : `No agent is ready on ${where.machine.name}.`
        : busy
          ? 'Starting…'
          : files.sending
            ? 'Wait for uploads to finish, or cancel them.'
            : harness && !options && !optionsError
              ? 'Loading models…'
              : options && options.permissions.length > 0 && !permission
                ? 'No permission is open to the phone for this chat. Change it on your Mac.'
                : null;
  // the agent picked, from the Mac's list (none until the Mac lists one)
  const agent = where.harnesses.find((h) => h.id === harness);
  // the chips wrap onto a second line when they are wider than the screen: a long machine name must not push the folder off it
  const chips = start && (
    <View style={{ flex: 1, flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
      {agent && (
        <Chip
          label="Agent"
          value={agent.label}
          icon={<Icon name="cpu" glyph="◆" size={15} color={theme.ink} />}
          onPress={() => setSheet('agent')}
        />
      )}
      {where.machine ? (
        <Chip
          label="Computer"
          value={where.machine.name}
          icon={<ToneDot tone={where.machine.tone} />}
          onPress={() => setSheet('computer')}
        />
      ) : (
        <Chip
          label="Computer"
          value={mac.name}
          icon={<View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: mac.online ? theme.ok : theme.ink3 }} />}
          onPress={() => setSheet('computer')}
        />
      )}
      {choices.length > 0 && <SignInChip source={source} machineName={machineName} onPress={() => setSheet('signin')} />}
      {where.remote && (
        <Chip
          label="Folder"
          value={folderChip(where.folder)}
          missing={!where.folder}
          icon={<Icon name="folder" glyph="▸" size={15} color={theme.ink} />}
          onPress={() => setSheet('folder')}
        />
      )}
      {!where.remote && start.projects.length > 0 && (
        <Chip
          label="Project"
          value={projectChip(
            start.projects.find((p) => p.id === project),
            worktree,
          )}
          icon={<Icon name="arrow.triangle.branch" glyph="⑂" size={15} color={theme.ink} />}
          onPress={() => setSheet('project')}
        />
      )}
    </View>
  );
  return (
    // New chat is a page sheet, outside the app frame's keyboard avoidance: it lifts its own composer above the keyboard
    <Animated.View style={[styles.page, ride]}>
      <PageHeader
        left={
          <GlassCircle label="Back" onPress={leave}>
            <Icon name="chevron.left" glyph="‹" size={20} color={theme.ink} />
          </GlassCircle>
        }
      />
      <View
        onTouchEnd={Keyboard.dismiss}
        style={{ flex: 1, alignItems: 'center', justifyContent: 'center', gap: 14, paddingHorizontal: 24 }}
      >
        <Spark size={44} />
        <Text accessibilityRole="header" style={{ fontFamily: serifFamily(), ...typo.title1, color: theme.ink, textAlign: 'center' }}>
          {greeting(runtime.snapshot().user?.name)}
        </Text>
        {!!status && (
          <Text accessibilityLiveRegion="polite" style={[styles.muted, { textAlign: 'center' }]}>
            {status}
          </Text>
        )}
        <ErrorLine text={error ?? optionsError} />
        {!start && !!error && <Button secondary title="Retry" onPress={begin} />}
        {unconfirmed && <Notice {...unconfirmedNotice('start')} />}
      </View>
      <ComposerBox
        value={busy ? '' : text}
        onChangeText={setText}
        placeholder="Describe a task or ask a question"
        chips={chips}
        above={
          where.remote ? (
            <>
              <CredentialNote agent={machineAgent} source={source} using={using} machineName={machineName} />
              {!!text && !!popupAt(text, text.length, []) && <Text style={styles.muted}>File references and skills stay on this Mac.</Text>}
            </>
          ) : (
            <ComposerMenu menu={menu.menu} skills={menu.skills} pick={menu.pick} removeSkill={menu.removeSkill} />
          )
        }
        fieldProps={{
          autoFocus: focus,
          ...(menuOn && { onChangeText: menu.onChangeText, selection: menu.selection, onSelectionChange: menu.onSelectionChange }),
        }}
        tray={<AttachmentStrip items={files.items} retry={files.retry} remove={files.remove} />}
        onAttach={start ? () => setSheet('attach') : undefined}
        bar={options && picked ? <ModelPill model={picked.label} detail={effortLabel} onPress={() => setSheet('model')} /> : undefined}
        end={
          <>
            {start && (
              <ComposerButton
                label="Dictate"
                onPress={() => setSheet('voice')}
                icon={<Icon name="mic" glyph="🎤" size={18} color={theme.ink} />}
              />
            )}
            <ComposerButton
              label="Start chat"
              strong
              disabled={!ready}
              onPress={() => void submit()}
              icon={<Icon name="arrow.up" glyph="↑" size={18} color={theme.btnInk} />}
            />
          </>
        }
      />
      {start && (
        <>
          <AgentSheet
            open={sheet === 'agent'}
            close={() => setSheet(null)}
            harnesses={where.harnesses}
            harness={harness}
            pick={setHarness}
          />
          {where.machines ? (
            <MachineSheet
              open={sheet === 'computer'}
              close={() => setSheet(null)}
              machines={where.machines}
              picked={where.host}
              pick={where.pick}
            />
          ) : (
            <ComputerSheet open={sheet === 'computer'} close={() => setSheet(null)} name={mac.name} online={mac.online} />
          )}
          {where.remote && (
            <FolderSheet
              open={sheet === 'folder'}
              close={() => setSheet(null)}
              request={request}
              machine={where.host}
              pick={where.setFolder}
            />
          )}
          <ProjectSheet
            open={sheet === 'project'}
            close={() => setSheet(null)}
            projects={start.projects}
            project={project}
            worktree={worktree}
            pick={setProject}
            setWorktree={setWorktree}
          />
          <CredentialSheet
            open={sheet === 'signin'}
            close={() => setSheet(null)}
            choices={choices}
            source={source}
            using={using}
            pick={setSource}
          />
          {options && (
            <ModelSheet
              open={sheet === 'model'}
              close={() => setSheet(null)}
              // an account is this Mac's: not offered for a chat on a Host
              options={where.remote ? { ...options, accounts: [] } : options}
              model={model}
              effort={effort}
              permission={permission}
              account={account}
              pickModel={(id) => {
                setModel(id);
                // an effort the new model does not list is replaced by its own default
                const next = options.models.find((m) => m.id === id);
                if (!next?.efforts.some((e) => e.id === effort)) setEffort(next?.defaultEffort ?? null);
              }}
              pickEffort={setEffort}
              pickPermission={setPermission}
              pickAccount={setAccount}
            />
          )}
          <AddToSessionSheet
            open={sheet === 'attach'}
            onClose={() => setSheet(null)}
            media={media}
            files={files}
            permission={
              options && options.permissions.length
                ? { value: options.permissions.find((p) => p.id === permission)?.label, open: () => setSheet('model') }
                : undefined
            }
            computer={{ value: where.machine?.name ?? mac.name, open: () => setSheet('computer') }}
          />
          <BottomSheet open={sheet === 'voice'} title="Dictate" onClose={() => setSheet(null)} keyboardInset={lift}>
            <VoiceNote
              media={media}
              request={request}
              caps={start.caps}
              use={(t) => {
                setText((old) => (old.trim() ? `${old.trim()} ${t}` : t));
                setSheet(null);
              }}
            />
          </BottomSheet>
        </>
      )}
    </Animated.View>
  );
}
