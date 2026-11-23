// MoMo as Claude's Dispatch: one continuous chat under a header with MoMo's Online, Offline or "Paused · Tap to resume" capsule from the Mac, a sticky "N need you" pill, reminders and requests in the chat, and Memory, Routines, Brain and Pause behind ⋯.
import type { DraftHandle } from '../presentation/drafts';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Keyboard, ScrollView, Text, View } from 'react-native';
import { Tap } from '../ui/ds/Tap';
import type { MobileRuntime, MobileSnapshot } from '../contracts';
import { GlassCircle } from '../components/Glass';
import { Icon } from '../components/Icon';
import { FollowOverlays } from '../components/FollowOverlays';
import { MenuButton, type MenuItem } from '../components/Menu';
import { Notice } from '../components/Notice';
import { PageHeader } from '../components/PageHeader';
import type { CardData } from '../components/RequestCard';
import { Button, ErrorLine, useStyles } from '../components/ui';
import { createMomoApi, messageOf } from '../momo/api';
import { channelChatKey } from '../momo/channelsContract';
import type { MomoCache } from '../momo/cache';
import { momoRows, type MomoRow } from '../momo/chatRows';
import { changedTopic } from '../momo/contract';
import { cardKey } from '../momo/needs';
import { useFollowedChat } from '../momo/useFollowedChat';
import { useLoad } from '../momo/useLoad';
import { useMomoGuard } from '../momo/useMomoGuard';
import { useNeeds } from '../momo/useNeeds';
import { choiceLabel } from '../presentation/receipts';
import type { Media } from '../platform/media';
import { lostInFlight, unconfirmedNotice, type Unconfirmable } from '../remote/unconfirmed';
import { useFollowEnd } from '../remote/useFollowEnd';
import { useProgressLine } from '../remote/useQuiet';
import { useUnconfirmed } from '../remote/useUnconfirmed';
import { useTheme } from '../theme';
import { useTranslation } from '../ui/i18n';
import { useHardwareBack } from '../useHardwareBack';
import { chatRef } from '../push/chatRef';
import { heldItems } from '../momo/held';
import { StatusCapsule, statusWord } from './MomoCapsule';
import { useChannelsPage } from './useChannelsPage';
import { useReviewFocus } from './useReviewFocus';
import { useSentLines } from '../momo/useSentLines';
import { MomoPending } from './MomoPending';
import { MomoDraftComposer, MomoTranscript, NUDGE_DONE, type NudgeAction, waitingKey } from './MomoChat';
import { recheck } from './MomoComputers';
import { MomoPage } from './MomoPage';
import { firstNewKey, SHELL_TABS, ShellFootnote, ShellPages, ShellPill, type ShellTab, tasksServed } from './MomoShell';
import type { PanelTask } from '../momo/taskPanelContract';
import { suggestionsShown, type Suggestion } from '../momo/suggestionsContract';
import { useBriefStates } from '../momo/useBriefStates';
import { MOMO_VOICE_METHOD, type MomoVoiceControl, MomoVoice, voiceShown } from './MomoVoice';
import { typo } from '../typography';

export { statusWord };

/** The chat id the outbox files MoMo's messages under (the Mac picks MoMo's real chat). */
export const MOMO_CHAT = 'momo';

/** "1 needs you", "3 need you". */
export const needsLine = (n: number) => `${n} need${n === 1 ? 's' : ''} you`;

/** The card a tapped MoMo push named (null: the end of the chat) and the channel it waits in (null: Main), with a new id per tap so a second tap scrolls again. */
export type MomoFocus = { card: string | null; channel?: string | null; tap: number };

export function Momo({
  runtime,
  state,
  cache,
  back,
  drafts,
  focus = null,
  media,
  computers,
}: {
  runtime: MobileRuntime;
  state: MobileSnapshot;
  cache?: Promise<MomoCache | null>;
  back: () => void;
  /** MoMo's draft, kept outside this screen for the app's lifetime. */
  drafts: DraftHandle;
  /** A tapped needs-you push: the card it named (chatRef of pair and card id), or null for the end of the chat; `tap` is new per tap. */
  focus?: MomoFocus | null;
  /** The phone's microphone (A5): with it, and a Mac that lists MoMo's voice method, the composer offers a voice note. */
  media?: Media;
  /** Leaving MoMo for a machine's page or the pairing flow, from MoMo's Computers section. */
  computers?: { open: (machineId: string) => void; pair: () => void };
}) {
  const styles = useStyles();
  const theme = useTheme();
  const { t } = useTranslation();
  // MoMo's page, opened from MoMo's name (or ⋯), answers the back button itself while open
  const [pageOpen, setPageOpen] = useState(false);
  // the shell's tab, the task its Tasks tab opened MoMo's page on, and the chat's rows when the reader last left it (what came after is New)
  const [tab, setTab] = useState<ShellTab>('chat');
  const [taskStart, setTaskStart] = useState<{ task: PanelTask; now: number } | { suggestion: Suggestion } | null>(null);
  const seen = useRef<Set<string> | null>(null);
  /** MoMo's page, opened on a task or a suggestion of the Tasks tab */
  const openPageOn = (start: NonNullable<typeof taskStart>) => (setTaskStart(start), setPageOpen(true));
  useHardwareBack(back, !pageOpen);
  // a channel (A2) is shown instead of Main while one is picked: its chat is followed, sent to and stopped by its id
  const [channelId, setChannelId] = useState<string | null>(null);
  const [channelsVersion, setChannelsVersion] = useState(0);
  // the chat's key in the outbox and in the per-chat state: MoMo's main chat, or a channel's
  const chatKey = channelId ? channelChatKey(channelId) : MOMO_CHAT;
  const api = useMemo(() => createMomoApi(runtime, channelId), [runtime, channelId]);
  const online = state.phase === 'online';
  const lastPair = useRef(state.selectedPair);
  if (state.selectedPair) lastPair.current = state.selectedPair;
  const scope = JSON.stringify([state.user?.id, lastPair.current]);
  const [changes, setChanges] = useState({ memory: 0, routines: 0, brain: 0, sources: 0, prefs: 0, chat: 0, state: 0 });
  const [actionError, setActionError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const follow = useFollowedChat(runtime, online, channelId);
  const reloadFollow = useRef(follow.reload);
  reloadFollow.current = follow.reload;
  useEffect(
    () =>
      runtime.onEvent((event) => {
        const area = event.ev === 'momo.changed' ? (event as { area?: unknown }).area : null;
        // a reminder or a note that lands in the main chat comes as 'chat': read the chat again; prefs and loops move MoMo's state
        if (area === 'chat') reloadFollow.current();
        if (area === 'channels') setChannelsVersion((v) => v + 1);
        if (area === 'prefs' || area === 'memory') setChanges((old) => ({ ...old, state: old.state + 1 }));
        const topic = changedTopic(event);
        if (topic) setChanges((old) => ({ ...old, [topic]: old[topic] + 1 }));
      }),
    [runtime],
  );
  // a failed request may mean the invite was withdrawn (useMomoGuard)
  const { guard, recheckAllowed } = useMomoGuard(runtime, api, cache, back);
  const methods = useLoad(runtime, () => (online ? api.methods() : Promise.resolve(null)), [api, online]);
  const has = (method: string) => !!methods.data?.has(method);
  // MoMo's channels (A2): the list, the one shown, the picker and the first row of an empty channel
  const channels = useChannelsPage({
    runtime,
    online,
    guard,
    has,
    methods: methods.data,
    channelId,
    setChannelId,
    version: channelsVersion,
    bump: () => setChannelsVersion((v) => v + 1),
    chat: () => setTab('chat'),
  });
  const channel = channels.channel;
  const momoState = useLoad(runtime, () => (online && has('momo.state.get') ? guard(api.state) : Promise.resolve(null)), [
    api,
    online,
    guard,
    methods.data,
    changes.state,
    changes.prefs,
  ]);
  // what became of the suggestions on the brief's cards, from the Mac's store (read only where suggestions are on)
  const briefStates = useBriefStates(runtime, api, guard, suggestionsShown(momoState.data, has), changes.memory, action);
  const brainSet = useLoad(runtime, () => (online ? guard(api.brainSet) : Promise.resolve(false)), [api, online, guard]);
  const routines = useLoad(runtime, () => (online ? guard(api.routines) : Promise.resolve(null)), [api, online, guard, changes.routines]);
  const sources = useLoad(runtime, () => (online ? guard(api.sources) : Promise.resolve(null)), [api, online, guard, changes.sources]);
  // a send, stop or answer that was in flight as the connection went: MoMo may have taken it; the notice goes when the chat shows what became of it
  const sessionNow = follow.thread?.session;
  const unconfirmed = useUnconfirmed(
    JSON.stringify([sessionNow?.turnStatus, Array.isArray(sessionNow?.cards) ? (sessionNow.cards as CardData[]).map(cardKey) : []]),
  );
  async function action(work: () => Promise<unknown>, kind?: Unconfirmable) {
    setBusy(true);
    setActionError(null);
    const lost = unconfirmed.begin();
    try {
      await guard(work);
    } catch (e) {
      if (follow.mounted.current) {
        if (kind && lostInFlight(e)) lost(kind);
        else setActionError(messageOf(e));
        setBusy(false);
      }
      return false;
    }
    if (follow.mounted.current) setBusy(false);
    return true;
  }
  // The shared outbox owns messages across navigation and refusal; clear the draft only after admission.
  function send() {
    // The composer sends only a draft with words in it.
    const text = drafts.get();
    try {
      sentLines.note(runtime.send(chatKey, text, [], [], true), text);
    } catch (e) {
      setActionError(messageOf(e));
      return;
    }
    end.pin(text);
    Keyboard.dismiss();
    setActionError(null);
    unconfirmed.clear();
    drafts.clear(text);
  }
  const status = momoState.data?.status ?? null;
  const paused = status === 'paused';
  async function setPausedTo(next: boolean) {
    if (await action(() => api.setPaused(next))) setChanges((old) => ({ ...old, state: old.state + 1 }));
  }
  const sessionCards = follow.thread?.session.cards;
  const cards = useMemo(() => (Array.isArray(sessionCards) ? sessionCards : []) as CardData[], [sessionCards]);
  const needs = useNeeds(follow.thread ? cards : null, chatKey);
  const progressLine = useProgressLine(follow.thread);
  const rows = useMemo(() => (follow.thread ? momoRows(follow.thread, Date.now()) : []), [follow.thread]);
  // the shell's pill is the design's: Chat · Tasks · Make for every account that has MoMo, whatever the Mac's shell flag says; Tasks says so when this Mac cannot serve it
  const tabs = SHELL_TABS;
  const tasksOn = tasksServed(momoState.data ?? null, has);
  const shownTab = tab;
  const pick = (next: ShellTab) => {
    if (shownTab === 'chat' && next !== 'chat') seen.current = new Set(rows.map((r) => r.key));
    setTab(next);
  };
  // a reminder answered here stays in the chat as a note: it is told apart by the loop it acted on, so it no longer waits
  const [closed, setClosed] = useState<Record<string, string>>({});
  const stillOpen = (r: MomoRow) => r.kind === 'nudge' && !closed[r.nudge.loopId];
  const waitingNudges = rows.filter(stillOpen).length;
  const waiting = cards.filter((c) => !c.inApp).length + waitingNudges;
  const working = follow.thread?.session.turnStatus === 'running' || follow.thread?.session.turnStatus === 'inProgress';
  // the pill takes the reader to the first thing waiting
  // the chat opens at its newest message and follows a reply while the reader stays at the bottom, as every other chat does
  const end = useFollowEnd(follow.thread ? `${scope}:${chatKey}` : `${scope}:${chatKey}:loading`);
  const scroller = end.ref;
  // where each waiting thing was last laid out, by its key; a layout is reported only when it changes, so it is kept across renders
  const placed = useRef(new Map<string, number>());
  const waitingKeys = [...rows.filter(stillOpen).map((r) => r.key), ...cards.filter((c) => !c.inApp).map(waitingKey)];
  /** The top of the highest thing still waiting that has been laid out; null before any is. */
  const firstWaiting = () => {
    const ys = waitingKeys.flatMap((k) => (placed.current.has(k) ? [placed.current.get(k)!] : []));
    return ys.length ? Math.min(...ys) : null;
  };
  // a tapped push's card: scrolled to once it is laid out; answered or gone, the end of the chat, with no error
  const aim = useRef<string | null>(null);
  const handled = useRef<number | null>(null);
  const pairId = lastPair.current;
  // a tap of Tasks' Review or of a push names the chat a card waits in (a channel's id, or Main): the page shows that chat first, then scrolls to the card
  const { aimedAt, reviewCard } = useReviewFocus({ focus, channelId, setChannelId, pairId });
  useEffect(() => {
    const focus = aimedAt;
    if (!focus || handled.current === focus.tap || !follow.thread) return;
    // the chat it names is not the one shown yet: wait for it, so the card is looked for in the right list
    if (focus.channel !== undefined && (focus.channel ?? null) !== channelId) return;
    handled.current = focus.tap;
    const card = focus.card && pairId ? cards.find((c) => !c.inApp && chatRef(pairId, String(c.id)) === focus.card) : undefined;
    aim.current = null;
    if (!card) return void scroller.current?.scrollToEnd({ animated: false });
    const y = placed.current.get(waitingKey(card));
    if (y !== undefined) scroller.current?.scrollTo({ y, animated: true });
    else aim.current = waitingKey(card);
  }, [aimedAt, follow.thread, cards, pairId, scroller, channelId]);
  const scrollToWaiting = () => {
    const y = firstWaiting();
    if (y !== null) scroller.current?.scrollTo({ y, animated: true });
  };
  const queued = state.outbox.filter((item) => item.momo && item.pairId === pairId && item.chatId === chatKey);
  // your line stays from the tap until the chat records it: the outbox lets go when the Mac takes it, the Mac records it later
  const sentLines = useSentLines(follow.thread, rows, queued, `${scope}:${chatKey}`);
  // what the Mac holds for the running turn stays on screen after the outbox let go of it, until the chat shows it
  // a turn waiting for your answer is still open: what you send goes after it, not on hold
  const turnOpen = working || follow.thread?.session.turnStatus === 'awaitingUser';
  const held = heldItems(follow.thread?.session, queued, 'momo');
  // a send the Mac refused may mean the invite was withdrawn, as for any other request
  const refused = queued
    .filter((item) => item.status === 'failed')
    .map((item) => item.id)
    .join();
  useEffect(() => {
    if (refused) recheckAllowed();
  }, [refused, recheckAllowed]);
  const word = statusWord(status, online);
  const menu: MenuItem[] = [
    { label: 'MoMo’s page', onPress: () => setPageOpen(true) },
    ...channels.menu,
    ...(has('momo.prefs.set') && status
      ? [{ label: paused ? 'Resume MoMo' : 'Pause MoMo', onPress: () => void setPausedTo(!paused) }]
      : []),
  ];
  const capsule = <StatusCapsule word={word} paused={paused} busy={busy} resume={() => void setPausedTo(false)} />;
  const composer = (voice: MomoVoiceControl | null) => (
    <MomoDraftComposer
      drafts={drafts}
      send={send}
      stop={() => void action(api.stop, 'stop')}
      working={turnOpen}
      disabled={busy}
      voice={voice}
      micOff={!online}
      placeholder={channel ? t('momoChannels.placeholder', { name: channel.name }) : undefined}
    />
  );
  return (
    <View style={styles.page}>
      <PageHeader
        subtitle={
          <View style={{ alignItems: 'center' }}>
            <Tap
              accessibilityRole="button"
              accessibilityLabel={`${momoState.data?.name ?? 'MoMo'}, MoMo’s page`}
              onPress={() => setPageOpen(true)}
              style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}
            >
              <Text accessibilityRole="header" numberOfLines={1} style={{ ...typo.bodySemibold, color: theme.ink }}>
                {channel ? `#${channel.name}` : (momoState.data?.name ?? 'MoMo')}
              </Text>
              <Icon name="chevron.down" glyph="⌄" size={11} color={theme.ink2} />
            </Tap>
            {capsule}
          </View>
        }
        left={
          <GlassCircle label="Back" onPress={back}>
            <Icon name="chevron.left" glyph="‹" size={20} color={theme.ink} />
          </GlassCircle>
        }
        right={
          <View
            style={{
              height: 48,
              minWidth: 48,
              borderRadius: 24,
              alignItems: 'center',
              justifyContent: 'center',
              backgroundColor: theme.surface,
              borderWidth: 1,
              borderColor: theme.glassLine,
            }}
          >
            <MenuButton label="More" items={menu} />
          </View>
        }
      />
      <View style={{ flex: 1, display: shownTab === 'chat' ? 'flex' : 'none' }}>
        {waiting > 0 && (
          <Tap
            accessibilityRole="button"
            accessibilityLabel={needsLine(waiting)}
            onPress={scrollToWaiting}
            style={{
              alignSelf: 'center',
              flexDirection: 'row',
              alignItems: 'center',
              gap: 6,
              minHeight: 34,
              paddingHorizontal: 14,
              borderRadius: 17,
              backgroundColor: theme.surface,
              borderWidth: 1,
              borderColor: theme.glassLine,
              marginBottom: 6,
            }}
          >
            <Icon name="hand.raised" glyph="✋" size={14} color={theme.amber} />
            <Text style={{ ...typo.subhead, color: theme.ink }}>{needsLine(waiting)}</Text>
          </Tap>
        )}
        <View style={{ flex: 1 }}>
          <ScrollView
            ref={scroller}
            contentContainerStyle={{ paddingTop: 8, paddingBottom: 16, minHeight: end.reserve }}
            keyboardShouldPersistTaps="handled"
            scrollEventThrottle={32}
            {...end.props}
          >
            <View style={{ paddingHorizontal: 18, gap: 8 }}>
              <ErrorLine text={actionError ?? follow.error} />
              {unconfirmed.kind && <Notice {...unconfirmedNotice(unconfirmed.kind)} />}
              {!!follow.error && <Button secondary title="Retry" onPress={follow.reload} />}
              {!online && <Text style={styles.muted}>Your Mac is asleep or offline. Your message stays here until you can send it.</Text>}
              {online && !follow.error && sources.data && !sources.data.calendar && !sources.data.reminders && (
                <Text style={styles.muted}>Connect Calendar and Reminders on your Mac in Settings &gt; MoMo &gt; Sources.</Text>
              )}
            </View>
            {follow.thread && rows.length === 0 && channels.welcome((text) => runtime.send(chatKey, text, [], [], true))}
            <MomoTranscript
              rows={rows}
              queued={
                <MomoPending waiting={sentLines.waiting} held={held} queued={queued} turnOpen={turnOpen} calls={sentLines.calls(runtime)} />
              }
              cards={cards}
              answeredOnMac={needs.answeredOnMac}
              answeredHere={needs.answeredHere}
              answer={async (card, key) => {
                // the Mac's update that takes the card away can arrive before this answer's reply: it is marked mine first, and unmarked if the answer fails
                const id = cardKey(card);
                const was = needs.mine.current.has(id);
                needs.mine.current.add(id);
                const done = await action(() => api.answer(card.id, card.rev, key), 'answer');
                if (!done && !was) needs.mine.current.delete(id);
                if (done) needs.noteAnswered(card, choiceLabel(card, key));
                return done;
              }}
              closed={closed}
              act={(nudge, act: NudgeAction) =>
                void action(() => api.loopAct(nudge.loopId, act)).then((ok) => {
                  if (!ok) return;
                  setClosed((was) => ({ ...was, [nudge.loopId]: NUDGE_DONE[act] }));
                  follow.reload();
                })
              }
              briefAct={briefStates.act}
              briefState={briefStates.stateOf}
              briefOn={briefStates.on}
              canAct={online && !busy}
              working={!!working}
              progress={progressLine}
              empty={
                <Text style={styles.muted}>{follow.thread ? 'No messages yet.' : online && !follow.error ? 'Loading MoMo…' : ''}</Text>
              }
              newKey={firstNewKey(rows, seen.current)}
              cardRef={(key, y) => {
                placed.current.set(key, y);
                if (aim.current === key) {
                  aim.current = null;
                  scroller.current?.scrollTo({ y, animated: true });
                }
              }}
            />
          </ScrollView>
          <FollowOverlays scroller={end.ref} away={end.awayStore} jump={end.jump} />
        </View>
        {media ? (
          <MomoVoice runtime={runtime} media={media} drafts={drafts}>
            {(voice) => composer(voiceShown(has(MOMO_VOICE_METHOD), voice))}
          </MomoVoice>
        ) : (
          composer(null)
        )}
      </View>
      <ShellPages
        tab={shownTab}
        served={tasksOn}
        runtime={runtime}
        api={api}
        guard={guard}
        version={changes.state + changes.memory + waiting}
        review={(task) => {
          setTab('chat');
          reviewCard(task);
        }}
        open={(task, now) => openPageOn({ task, now })}
        suggestions={suggestionsShown(momoState.data, has)}
        openSuggestion={(suggestion) => openPageOn({ suggestion })}
      />
      {shownTab === 'chat' && <ShellFootnote />}
      <ShellPill tabs={tabs} tab={shownTab} pick={pick} />
      {channels.sheet}
      <MomoPage
        computers={computers && { ...computers, check: () => recheck(runtime) }}
        open={pageOpen}
        close={() => {
          setPageOpen(false);
          setTaskStart(null);
        }}
        start={taskStart}
        runtime={runtime}
        api={api}
        guard={guard}
        has={has}
        online={online}
        state={momoState.data ?? null}
        waiting={waiting}
        showWaiting={(task) => {
          setPageOpen(false);
          if (task) reviewCard(task);
          else scrollToWaiting();
        }}
        routines={routines}
        brainSet={brainSet.data === true}
        version={changes.state + changes.brain + changes.sources + changes.prefs}
        cache={cache}
        scope={scope}
        memoryVersion={changes.memory}
      />
    </View>
  );
}
