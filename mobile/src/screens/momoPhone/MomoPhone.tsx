// MoMo on the phone: the tabs (Chat, Tasks, Notes) over one store, with Where MoMo runs, Rules and Settings as pages; the chat keeps MoMo's composer, its draft and its push-tap focus; local navigation never reaches the home.
import { say } from '../../momoPhone/say';
import { type ComponentRef, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AccessibilityInfo, Keyboard, Linking, ScrollView, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { BackLink } from '../../components/BackLink';
import type { MomoStore } from '../../momoPhone/store';
import type { Intent } from '../../momoPhone/types';
import { composerHint, withTurns } from '../../momoPhone/viewModels';
import { notNeeded } from '../../momoPhone/workModels';
import type { DraftHandle } from '../../presentation/drafts';
import { useTheme } from '../../theme';
import { useTranslation } from '../../ui/i18n';
import type { MobileRuntime } from '../../contracts';
import type { Media } from '../../platform/media';
import { useReducedMotionEnabled } from '../../ui/ds/useReducedMotion';
import { MomoDraftComposer } from '../MomoChat';
import { MomoVoice, type MomoVoiceControl, voiceShown } from '../MomoVoice';
import { Pill } from '../MomoPill';
import { HeaderPill, HomeBanner, ProblemBanners, TabPill, type Tab } from './ChatParts';
import { CHAT_PAGE, ChatRows } from './ChatRows';
import { NewNote, NoteDetail, NotesList, NotesScreen } from './Notes';
import { BriefSettings, PermissionPrompt, PreviewSettings, RulesScreen, WhyYouSawThis } from './Settings';
import { PickMachine, StopConfirm, TaskDetailScreen, TasksScreen } from './Tasks';
import { FirstRun, MoveCard, WhereMomoRuns } from './Where';
import { Boundary } from './Boundary';
import { Body, Card, Failure, Skeleton, Title } from './parts';
import { parseHomeView } from '../../momoPhone/transport';
import { chatRef } from '../../push/chatRef';
import { moveStepLabel } from '../../momoPhone/viewModels';
import { MomoStoreContext, useBusyCount, useCached, useFailure, useLoaded, useLoading, useLost, useTurns, useView } from './useMomoStore';

const SETTINGS = ['rules', 'brief', 'permission', 'previews'];

type Page =
  | null
  | 'where'
  | 'rules'
  | 'brief'
  | 'permission'
  | 'previews'
  | 'new-note'
  | { task: string }
  | { pick: string }
  | { note: string }
  | { why: string };

/** The time the screen reads cards against, moved on every half minute so a card that expires does so on screen. */
function useNow(clock: () => number): number {
  const [now, setNow] = useState(clock);
  useEffect(() => {
    const id = setInterval(() => setNow(clock()), 30_000);
    return () => clearInterval(id);
  }, [clock]);
  return now;
}

/** A push tap's card: the chat tab shows it, outlined. */
type Focus = { card: string | null; tap: number } | null;

export function MomoPhone({
  store,
  back,
  drafts,
  focus = null,
  pairId = null,
  voice = undefined,
  clock = Date.now,
  classic,
}: {
  store: MomoStore;
  back: () => void;
  /** MoMo's draft, kept outside this screen for the app's lifetime. */
  drafts: DraftHandle;
  /** A tapped needs-you push: the card it named (the pair and card id as `chatRef` writes them), or null for the end of the chat. */
  focus?: Focus;
  pairId?: string | null;
  /** The voice note the classic screen offers (A5): with the phone's microphone and a computer that lists the method. */
  voice?: { runtime: MobileRuntime; media: Media; listed: boolean; online: boolean };
  clock?: () => number;
  /** Opens the classic MoMo screen: its channels, Pause MoMo and MoMo's page. */
  classic?: () => void;
}) {
  useTranslation(); // the whole screen draws again when the language changes
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  useLoaded(store);
  const raw = useView(store);
  const failure = useFailure(store);
  const turns = useTurns(store);
  const cached = useCached(store);
  const lost = useLost(store);
  const loading = useLoading(store);
  const busyCount = useBusyCount(store);
  const now = useNow(clock);
  const [tab, setTab] = useState<Tab>('chat');
  const [page, setPage] = useState<Page>(null);
  const [stopping, setStopping] = useState(false);
  const [chosen, setChosen] = useState<string | null>(null);
  const [aimed, setAimed] = useState<string | null>(null);
  const [shown, setShown] = useState(CHAT_PAGE);
  const scroller = useRef<ComponentRef<typeof ScrollView>>(null);
  // the chat is read from its end: on open, after a push tap and after a send, until the person scrolls away
  const follow = useRef(true);
  const reduceMotion = useReducedMotionEnabled();
  const view = useMemo(() => (raw ? withTurns({ ...raw, now }, turns) : null), [raw, now, turns]);
  // a failure stays in front of the person: the page goes to the top where it is drawn (a press far down the page must not look like nothing happened), and it is read aloud
  const followedBefore = useRef<boolean | null>(null);
  useEffect(() => {
    if (!failure) {
      // the notice is gone (dismissed, or the next press worked): the chat is read from its end again if it was before
      if (followedBefore.current !== null) follow.current = followedBefore.current;
      followedBefore.current = null;
      return;
    }
    AccessibilityInfo.announceForAccessibility(failure.cause);
    // a notice told on a timer, while the person reads on, does not move the page
    if (failure.late) return;
    // the banner makes the page taller: the chat must not follow its end and carry the page back down past it
    if (followedBefore.current === null) followedBefore.current = follow.current;
    follow.current = false;
    scroller.current?.scrollTo({ y: 0, animated: !reduceMotion });
  }, [failure, reduceMotion]);
  // what finished is said aloud too: a move's step as it changes, and a done when everything asked has been answered
  const wasBusy = useRef(0);
  useEffect(() => {
    if (wasBusy.current > 0 && busyCount === 0 && !failure) AccessibilityInfo.announceForAccessibility(say('done'));
    wasBusy.current = busyCount;
  }, [busyCount, failure]);
  const moveStep = raw?.view.home.move?.outcome === 'running' ? raw.view.home.move.step : null;
  useEffect(() => {
    if (moveStep) AccessibilityInfo.announceForAccessibility(moveStepLabel(moveStep));
  }, [moveStep]);
  // a push tap: the chat tab, no page over it, and the card it named outlined (or the end of the chat)
  useEffect(() => {
    if (!focus) return;
    setPage(null);
    setStopping(false);
    setTab('chat');
    setAimed(focus.card);
    follow.current = focus.card === null;
  }, [focus]);
  // the card it named may be older than the rows drawn: they are drawn from it on, and the page scrolls to it
  useEffect(() => {
    if (!aimed || !pairId || !raw) return;
    const rows = raw.view.chat;
    const at = rows.findIndex((r) => r.kind === 'approval' && chatRef(pairId, r.approval.id) === aimed);
    if (at >= 0) setShown((n) => Math.max(n, rows.length - at + 1));
  }, [aimed, pairId, raw]);
  const toAimed = useCallback(
    (y: number) => scroller.current?.scrollTo({ y: Math.max(0, y - 16), animated: !reduceMotion }),
    [reduceMotion],
  );
  const act = (intent: Intent) => {
    if (intent.kind === 'open-where') setPage('where');
    else if (intent.kind === 'open-rules') setPage('rules');
    else if (intent.kind === 'open-settings') void Linking.openSettings();
    else if (intent.kind === 'pick-machine') setPage({ pick: intent.taskId });
    else void store.act(intent);
  };
  if (!view) {
    // the first read has not come, or it failed: say why and offer to try again; nothing is drawn as if MoMo were empty.
    // The notes this phone kept can be read meanwhile (never changed: the home is not there to take a change).
    const kept = cached?.length ? parseHomeView({ view: { home: { state: 'asleep' }, notes: cached } }, now) : null;
    const open = kept && typeof page === 'object' && page && 'note' in page ? kept.view.notes.find((n) => n.id === page.note) : undefined;
    return (
      <MomoStoreContext.Provider value={store}>
        <View style={{ flex: 1, backgroundColor: theme.bg }}>
          <View style={{ paddingTop: 8, paddingHorizontal: 16 }}>
            <BackLink onPress={() => (page ? setPage(null) : back())} />
          </View>
          <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{ padding: 16 }}>
            {loading && !failure && !kept && <Skeleton />}
            {failure && (
              <>
                <Title>{say('momoIsnTReachable')}</Title>
                <Failure failure={failure} act={act} dismiss={store.dismissFailure} />
                <Pill strong disabled={false} title={say('tryAgain')} onPress={() => void store.load()} />
              </>
            )}
            {kept &&
              (open ? <NoteDetail view={kept} note={open} act={act} /> : <NotesList view={kept} open={(id) => setPage({ note: id })} />)}
          </ScrollView>
        </View>
      </MomoStoreContext.Provider>
    );
  }
  // Back closes the open page or sheet first, and leaves MoMo only from the tab itself
  const up = () => (stopping ? setStopping(false) : page ? setPage(SETTINGS.includes(page as string) ? 'where' : null) : back());
  const notice =
    typeof page === 'object' && page && 'why' in page
      ? view.view.chat.find((r): r is Extract<typeof r, { kind: 'assistant' }> => r.kind === 'assistant' && r.id === page.why)
      : undefined;
  const task = typeof page === 'object' && page && 'task' in page ? view.view.tasks.find((t) => t.id === page.task) : undefined;
  const note = typeof page === 'object' && page && 'note' in page ? view.view.notes.find((n) => n.id === page.note) : undefined;
  const chatOpen = !page && tab === 'chat' && view.view.setup.step !== 'where';
  const lastRow = view.view.chat[view.view.chat.length - 1];
  const working = lastRow?.kind === 'user' && lastRow.delivery === 'accepted';
  const composer = (note: MomoVoiceControl | null) => (
    <MomoDraftComposer
      drafts={drafts}
      working={working}
      disabled={false}
      voice={note}
      micOff={voice ? !voice.online : false}
      placeholder={composerHint(view)}
      send={() => {
        follow.current = true;
        // the draft goes only once the message is on the phone: one that could not be kept stays here, with the reason above
        const text = drafts.get();
        Keyboard.dismiss();
        void store.sendText(text).then((kept) => {
          if (kept) drafts.clear(text);
        });
      }}
      stop={() => lastRow && act({ kind: 'stop-turn', turnId: lastRow.id })}
    />
  );
  const body =
    view.view.setup.step === 'where' ? (
      <FirstRun view={view} act={act} chosen={chosen} choose={setChosen} />
    ) : page === 'where' ? (
      <>
        <MoveCard view={view} act={act} />
        <WhereMomoRuns view={view} act={act} go={setPage} classic={classic} />
      </>
    ) : page === 'rules' ? (
      <RulesScreen view={view} act={act} />
    ) : page === 'brief' ? (
      <BriefSettings view={view} act={act} />
    ) : page === 'permission' ? (
      <PermissionPrompt view={view} act={act} notNow={() => setPage(null)} />
    ) : page === 'previews' ? (
      <PreviewSettings view={view} act={act} />
    ) : page === 'new-note' ? (
      <NewNote act={act} done={() => setPage(null)} />
    ) : notice ? (
      <WhyYouSawThis
        row={notice}
        act={act}
        onNotNeeded={() => {
          act(notNeeded(notice.id, notice.decision?.decisionId));
          setPage(null);
        }}
      />
    ) : typeof page === 'object' && page && 'pick' in page ? (
      <PickMachine view={view} taskId={page.pick} act={act} done={() => setPage(null)} />
    ) : task ? (
      stopping ? (
        <StopConfirm task={task} act={act} close={() => setStopping(false)} />
      ) : (
        <TaskDetailScreen view={view} task={task} act={act} askStop={() => setStopping(true)} />
      )
    ) : note ? (
      <NoteDetail view={view} note={note} act={act} />
    ) : tab === 'tasks' ? (
      <TasksScreen view={view} act={act} open={(id) => setPage({ task: id })} ask={() => setTab('chat')} />
    ) : tab === 'notes' ? (
      <NotesScreen
        view={view}
        open={(id) => setPage({ note: id })}
        connect={() => act({ kind: 'google', intent: 'connect' })}
        write={() => setPage('new-note')}
      />
    ) : (
      <>
        {lost && (
          <Card tone="warn">
            <Body dim={false}>{say('unsentLost')}</Body>
            <Pill disabled={false} title={say('discard')} onPress={store.discardLost} />
          </Card>
        )}
        <HomeBanner view={view} act={act} />
        <ProblemBanners view={view} act={act} />
        <MoveCard view={view} act={act} />
        <ChatRows
          view={view}
          act={act}
          why={(id) => setPage({ why: id })}
          aimed={aimed && pairId ? aimed : null}
          pairId={pairId}
          onAimedLayout={toAimed}
          shown={shown}
          earlier={() => setShown((n) => n + CHAT_PAGE)}
        />
      </>
    );
  return (
    <MomoStoreContext.Provider value={store}>
      <View style={{ flex: 1, backgroundColor: theme.bg }}>
        <View
          style={{
            paddingTop: 8,
            paddingBottom: 8,
            paddingHorizontal: 16,
            flexDirection: 'row',
            alignItems: 'center',
            justifyContent: 'space-between',
          }}
        >
          <BackLink onPress={up} />
          <HeaderPill
            view={view}
            open={() => {
              setStopping(false);
              setPage(page === 'where' ? null : 'where');
            }}
          />
        </View>
        <ScrollView
          ref={scroller}
          keyboardShouldPersistTaps="handled"
          contentContainerStyle={{ padding: 16, paddingBottom: chatOpen ? 16 : insets.bottom + 96 }}
          // rows revealed above the first drawn one push it down: the page stays where it was
          maintainVisibleContentPosition={{ minIndexForVisible: 0 }}
          onScrollBeginDrag={() => {
            follow.current = false;
          }}
          // the person reaching the end of the chat reads it from its end again
          onScroll={(e) => {
            const { contentOffset, contentSize, layoutMeasurement } = e.nativeEvent;
            if (contentSize.height - contentOffset.y - layoutMeasurement.height < 24) follow.current = true;
          }}
          scrollEventThrottle={64}
          onContentSizeChange={() => {
            if (follow.current && chatOpen) scroller.current?.scrollToEnd({ animated: !reduceMotion });
          }}
        >
          <Failure failure={failure} act={act} dismiss={store.dismissFailure} />
          <Boundary
            resetKey={`${tab}:${JSON.stringify(page)}:${view.view.chat.length}`}
            fallback={
              <Card tone="warn">
                <Body dim={false}>{say('couldNotShow')}</Body>
                <Pill disabled={false} title={say('tryAgain')} onPress={() => void store.load()} />
              </Card>
            }
          >
            {body}
          </Boundary>
        </ScrollView>
        {chatOpen && (
          <View style={{ paddingBottom: insets.bottom + 72 }}>
            {voice ? (
              <MomoVoice runtime={voice.runtime} media={voice.media} drafts={drafts}>
                {(note) => composer(voiceShown(voice.listed, note))}
              </MomoVoice>
            ) : (
              composer(null)
            )}
          </View>
        )}
        <TabPill
          tab={tab}
          bottom={insets.bottom + 12}
          set={(t) => {
            setPage(null);
            setStopping(false);
            setTab(t);
          }}
        />
      </View>
    </MomoStoreContext.Provider>
  );
}
