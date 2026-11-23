// Mobile Remote's account, computer and chat navigation, backed by the shared runtime.
import { useCallback, useEffect, useRef, useState } from 'react';
import { StatusBar } from 'expo-status-bar';
import type { FirstMessage, MobileRuntime, MobileSnapshot } from './contracts';
import { ScreenFrame } from './components/ui';
import { NativeStack } from './components/NativeStack';
import { HomeRoute, useHomeActions } from './screens/HomeRoute';
import { stackOf, type NavState, type Route } from './stack';
import { chatListKey, useChatList } from './useChatList';
import { useOpenChatList } from './useOpenChatList';
import { useHomeFolds } from './useHomeFolds';
import { PairingRoute } from './screens/PairingRoute';
import { useLanding } from './useLanding';
import { usePairingSheet } from './usePairingSheet';
import { usePhoneInvite } from './usePhoneInvite';
import { ReviewHost } from './components/ReviewHost';
import { watchSnapshots, withoutOutbox } from './outboxView';
import { ChatRoute } from './screens/ChatRoute';
import { ScreenBoundary } from './components/ScreenBoundary';
import { Settings } from './screens/Settings';
import { deleteThenLeave } from './components/DeleteAccount';
import { useOpenChat, usePushUi } from './push/usePushUi';
import type { PushController } from './push/controller';
import { Momo, type MomoFocus } from './screens/Momo';
import { useMomoAccess } from './momo/useMomoAccess';
import type { MomoCache } from './momo/cache';
import type { ChatCache } from './presentation/chatCache';
import { NewChat } from './screens/NewChat';
import { Starting } from './screens/Starting';
import { Review } from './screens/Review';
import { Scheduled } from './screens/Scheduled';
import { Terminal } from './screens/Terminal';
import { MacLinkProvider } from './macLink';
import { ChatLinkContext } from './chatLinks';
import { useResolved } from './useResolved';
import { chatHeader, useChatTrail } from './useChatTrail';
import type { Media } from './platform/media';
import { createDraftStore, draftKey, startDraft } from './presentation/drafts';
import { forgetPairRows } from './presentation/threadCache';
import { leaveAccount } from './accountLeave';
import type { PictureCache } from './presentation/pictureCache';
import { useDiskCaches } from './remote/useDiskCaches';
import { homeTaps, useHostWaiting, useStartedChats } from './remote/useHostWaiting';
import { useAwayNewChat } from './remote/useAwayNewChat';
import { momoComputers, useSettingsRoute } from './remote/useSettingsRoute';
/** Where a chat runs, for its navigation bar: its agent and its project. */
const owner = (snapshot: MobileSnapshot) => JSON.stringify([snapshot.user?.id, snapshot.selectedPair, snapshot.generation]);
/** `media` (photos, camera, voice) and new chats are offered only where the app supplies it; `momo` where MoMo is wired. */
export function MobileApp({
  runtime,
  media,
  momo: momoSetup,
  rows: rowsSetup,
  lists: listsSetup,
  pictures: picturesSetup,
  push,
  appearance,
  haptics,
  phoneUi,
  homeLayout,
  version,
  phoneName,
  devEndpoints,
}: {
  runtime: MobileRuntime;
  media?: Media;
  momo?: { cache: Promise<MomoCache | null> };
  rows?: Promise<ChatCache | null>; // the sealed copy of each chat's last rows, so an opened chat paints from disk
  lists?: Parameters<typeof useChatList>[0]['lists']; // the sealed last chat list per computer: the list paints from disk at launch
  pictures?: Promise<PictureCache | null>; // the sealed thumbnails of attached pictures: a chat reopened draws them at once
  push?: PushController;
  appearance?: import('./appearance').AppearanceControl;
  haptics?: import('./haptics').HapticsControl;
  phoneUi?: import('./ui/flag').PhoneUiControl;
  homeLayout?: import('./homeLayout').HomeLayoutControl; // the saved By project / By state choice of the Chats home
  version?: string; // shown under Settings › About
  phoneName?: string;
  devEndpoints?: { relayUrl: string; accountOrigin: string }; // the relay and account of a dev-override build; absent otherwise
}) {
  const pushUi = usePushUi(push);
  const [state, setState] = useState<MobileSnapshot>(() => withoutOutbox(runtime.snapshot()));
  // every draft, outside the React state: typing writes here, and only the composer that shows the text renders
  const [drafts] = useState(createDraftStore);
  const { invite, host } = usePhoneInvite(runtime, state.user?.id);
  const [creatingFor, setCreatingFor] = useState<string | undefined>(); // the account that opened New chat: another account starts at the home list
  const creating = creatingFor !== undefined && creatingFor === state.user?.id;
  const landing = useLanding(creating, () => setCreatingFor(state.user?.id)); // a computer this phone just paired lands on its new-chat page, keyboard up
  // it waits for the answer: an uninvited account has nothing to scan
  const [pairing, setPairing] = usePairingSheet(state, invite === 'invited' || invite === 'unknown', landing.arrive);
  const { settings, setSettings, settingsPage, closeSettings, openMachine, openNewChat } = useSettingsRoute();
  const awayNewChat = useAwayNewChat(runtime, !!state.user && state.phase !== 'online', openNewChat, () => setSettings(true));
  // Settings belongs to the account that opened it: no account, or another one, starts at the home list
  const accountId = state.user?.id;
  const [settingsFor, setSettingsFor] = useState(accountId);
  if (settingsFor !== accountId) {
    setSettingsFor(accountId);
    closeSettings();
  }
  const { chat, trail, ask, show: showChat, push: pushChat, pop: popChat, clear: clearChat } = useChatTrail();
  const openChatFromSettings = (id: string) => (closeSettings(), showChat(id));
  const hostWaiting = useHostWaiting(runtime, !chat && !settings);
  const started = useStartedChats(runtime);
  // a chat named in a reply opens over the one it is in, and Back returns there; a link to the open chat stays put (`selected`: words a side chat quotes in its composer)
  const openLinkedChat = (id: string, selected?: string) => (
    startDraft(drafts.of(draftKey(state.user?.id, lastPair.current, id)), selected), setReviewId(null), pushChat(id, reviewId ?? undefined)
  );
  const [momo, setMomo] = useState<Promise<MomoCache | null> | null>(null);
  // the card a tapped MoMo push named (null: the end of the chat), with a new id per tap so a second tap scrolls again
  const [momoFocus, setMomoFocus] = useState<MomoFocus | null>(null);
  const momoDraft = draftKey(state.user?.id, 'momo', 'momo');
  // Start was tapped and the computer has not said which chat it is: the message the chat's page shows meanwhile
  const [starting, setStarting] = useState<{ id: string; text: string; pictures?: string[] } | null>(null);
  // the chat that was just started with this message (and the computer's warning), so its page shows it from the first frame
  const [first, setFirst] = useState<(FirstMessage & { chatId: string; owner: string }) | null>(null);
  // New chat closed (a lost connection, another account): no start page is left behind for the next time it opens
  if (starting !== null && !creating) setStarting(null);
  if (first && first.owner !== JSON.stringify([state.user?.id, state.selectedPair])) setFirst(null);
  const [reviewing, setReviewing] = useState(false);
  const [scheduled, setScheduled] = useState(false);
  const [reviewId, setReviewId] = useState<string | null>(null); // the waiting chat whose requests are being answered in the quick review
  const [mirror, setMirror] = useState<'terminal' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [pulling, setPulling] = useState(false); // the pull to refresh is spinning (not any other action that holds the screen busy)
  const lifetime = useRef(0);
  // the computer the connection was last up to, for the banner's one-tap reconnect
  const lastPair = useRef<string | null>(null);
  if (state.selectedPair) lastPair.current = state.selectedPair;
  const reads = useRef(0);
  const actions = useRef(0);
  // the list belongs to an account and a computer: it stays, as the last one read, while that computer is away
  const listKey = chatListKey(state, lastPair.current);
  const homeFolds = useHomeFolds(homeLayout);
  const list = useChatList({ runtime, lifetime, reads, owner: () => owner(runtime.snapshot()), key: listKey, setError, lists: listsSetup });
  const { chats, more: moreChats, loading: loadingMore, loadMore } = list;
  const taps = homeTaps(hostWaiting, state.phase === 'online', runtime, chats, openMachine, showChat, setReviewId);
  const rowCache = useResolved(rowsSetup);
  const pictureCache = useResolved(picturesSetup);
  useDiskCaches({ rowCache, pictureCache, chats, whole: list.fresh && !list.more, account: state.user?.id, pair: state.selectedPair });
  useEffect(() => {
    const life = ++lifetime.current;
    let lastOwner = owner(runtime.snapshot());
    setState(withoutOutbox(runtime.snapshot()));
    const off = watchSnapshots(runtime, (next) => {
      if (life !== lifetime.current) return;
      if (owner(next) !== lastOwner) {
        lastOwner = owner(next);
        ++reads.current;
        ++actions.current;
        setBusy(false);
        setError(null);
      }
      setState(next);
    });
    void runtime.start().catch((e) => {
      if (life === lifetime.current) setError(e instanceof Error ? e.message : String(e));
    });
    return () => {
      ++lifetime.current;
      ++reads.current;
      ++actions.current;
      off();
    };
  }, [runtime]);
  const stateOwner = owner(state);
  const tapped = pushUi.target;
  useEffect(() => {
    if (!push || !tapped || state.phase !== 'online' || state.selectedPair !== tapped.pairId) return;
    if (tapped.momo && momoSetup) {
      closeSettings();
      setScheduled(false);
      setReviewId(null);
      setMomo(momoSetup.cache);
      setMomoFocus({ card: tapped.momo.card ?? null, channel: tapped.momo.channel ?? null, tap: Date.now() });
    } else if (tapped.chatId) {
      closeSettings();
      setScheduled(false);
      setReviewId(null);
      // MoMo is a screen over the list: a chat opened under it would stay hidden
      setMomo(null);
      showChat(tapped.chatId);
      const { chatId, draft } = tapped;
      // a reply typed into the notification is kept as a draft to review and send, after any draft already there
      if (draft) {
        const key = draftKey(state.user?.id, tapped.pairId, chatId);
        const held = drafts.of(key);
        held.set(held.get() ? `${held.get()}\n${draft}` : draft);
      }
    }
    push.consumeTarget();
  }, [push, tapped, state.phase, state.selectedPair, state.user?.id, showChat, momoSetup, closeSettings, drafts]);
  // the new chat's first message survives a dropped connection; it is kept per account and computer like a chat draft
  const newChatKey = draftKey(state.user?.id, state.selectedPair, '\u0000new');
  // a computer being waited for, or a list painted from disk before the first connection, keeps the open chat; it is followed when the connection returns
  const waiting = (state.phase === 'offline' && !!state.reconnect) || (state.phase === 'ready' && !!chats);
  const momoAllowed = useMomoAccess(runtime, !!momoSetup, state.phase === 'online');
  useEffect(() => {
    if (state.phase !== 'online') {
      ++reads.current;
      list.leave(state.phase === 'offline' || state.phase === 'ready');
      if (!waiting) clearChat();
      setReviewing(false);
      setReviewId(null);
      setScheduled(false);
      setMirror(null);
      return;
    }
    void list.read(true, stateOwner);
    return () => {
      ++reads.current;
    };
  }, [list.read, list.leave, state.phase, stateOwner, waiting, clearChat]);
  // the list is read on connect and by pull-to-refresh, and again each time the open chat changes (see useOpenChatList)
  const reread = useCallback(() => void list.read(false, stateOwner), [list.read, stateOwner]);
  useOpenChatList({ chat, chats, more: moreChats, loading: loadingMore, loadMore, online: state.phase === 'online', reread });
  // MoMo stays open while the computer is away so its saved memory can be read
  useEffect(() => {
    if (state.phase !== 'online' && state.phase !== 'offline') setMomo(null);
  }, [state.phase]);
  // leaves the account on this phone: the push registration, the session, and the saved MoMo memory that belongs to the account
  const leave = () => leaveAccount({ push, runtime, rowCache, listCache: list.cache, pictureCache, momoCache: momoSetup?.cache });
  async function run(fn: () => Promise<void>) {
    const life = lifetime.current;
    const key = owner(runtime.snapshot());
    const action = ++actions.current;
    const current = () => life === lifetime.current && action === actions.current && key === owner(runtime.snapshot());
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (e: unknown) {
      if (current()) setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (current()) setBusy(false);
    }
  }
  // Refresh holds the busy state, so "Load more chats" waits: a page asked for the old list would otherwise land on the new one
  async function refresh() {
    setPulling(true);
    try {
      await run(() => list.read(false, owner(runtime.snapshot())));
    } finally {
      setPulling(false);
    }
  }
  const momoOpen = !!momo && (state.phase === 'online' || state.phase === 'offline');
  const settingsOpen = !momoOpen && settings && !!state.user;
  const inFlow =
    !momoOpen &&
    !settingsOpen &&
    (scheduled || (creating && !!media && state.phase === 'online') || (!!chat && (state.phase === 'online' || waiting)));
  useOpenChat(push, state.selectedPair, inFlow ? chat : null);
  const pairingScreen = pairing && !state.pendingPair && !state.pairingCommit;
  // the header every screen of the open chat shares: its title and where it runs, and the ⋯ that opens Changes and Terminal
  const go = (screen: 'review' | 'terminal') => () => {
    // one screen of the open chat at a time: showing one clears the other
    setReviewing(screen === 'review');
    setMirror(screen === 'terminal' ? screen : null);
  };
  const chatNav = {
    ...chatHeader(chats, chat, trail),
    // a chat this phone started on a machine is called what it was asked until the machine names it
    ...(chat && !chats?.some((c) => c.id === chat) ? { title: runtime.direct?.chat?.titleOf(chat) } : {}),
    // Changes and Terminal open only while the computer is there
    ...(state.phase === 'online' ? { review: go('review'), terminal: go('terminal') } : {}),
    ownHarness: chats?.find((c) => c.id === chat)?.harness,
    hostId: chats?.find((c) => c.id === chat)?.hostId ?? (chat ? runtime.direct?.chat?.hostOf(chat) : undefined),
  };
  const closeChat = () => {
    popChat();
    setReviewing(false);
    setMirror(null);
  };
  // one flow at a time, as a native stack over the home list; each flag already accounts for the connection
  const nav: NavState = {
    momo: momoOpen,
    settings: settingsOpen,
    newChat: creating && !!media && state.phase === 'online',
    starting: starting?.id,
    scheduled: scheduled && state.phase === 'online',
    answer: reviewId && chats && state.phase === 'online' ? reviewId : null,
    chat: chat && (state.phase === 'online' || waiting) ? chat : null,
    trail,
    top: chat && state.phase === 'online' ? (reviewing ? 'review' : mirror) : null,
    pairing: pairingScreen,
  };
  // the system took a screen away (a swipe back, a sheet pulled down): the state follows
  const popped = (route: Route) => {
    if (route.kind === 'momo') setMomo(null);
    else if (route.kind === 'settings') closeSettings();
    else if (route.kind === 'starting') setStarting(null);
    else if (route.kind === 'newChat') setCreatingFor(undefined);
    else if (route.kind === 'scheduled') setScheduled(false);
    else if (route.kind === 'answer') {
      setReviewId(null);
      void refresh();
    } else if (route.kind === 'chat') closeChat();
    else if (route.kind === 'review') setReviewing(false);
    else if (route.kind === 'terminal') setMirror(null);
    else if (route.kind === 'pairing') setPairing(false);
  };
  // what the chats home does in the app, through functions that stay the same: the home is drawn again only when what it shows changed
  const homeAct = useHomeActions({
    open: taps.open,
    review: taps.review,
    machine: openMachine,
    showChat,
    momo: () => momoSetup && setMomo(momoSetup.cache),
    scheduled: () => setScheduled(true),
    settings: () => {
      setError(null);
      setSettings(true);
    },
    computers: () => setSettings(true),
    createChat: setCreatingFor,
    away: () => awayNewChat?.(),
    pair: () => setPairing(true),
    signOut: () => void run(leave),
    run,
    refresh: () => void refresh(),
    loadMore: () => chats && void loadMore(chats),
  });
  const render = (route: Route) => {
    if (route.kind === 'momo')
      return (
        <Momo
          runtime={runtime}
          state={state}
          cache={momo!}
          {...{ focus: momoFocus, media, computers: momoComputers(setMomo, openMachine, setPairing) }}
          back={() => setMomo(null)}
          drafts={drafts.of(momoDraft)}
        />
      );
    if (route.kind === 'settings')
      return (
        <Settings
          uninvited={invite === 'uninvited'}
          runtime={runtime}
          state={state}
          push={push}
          pushUi={pushUi}
          appearance={appearance}
          haptics={haptics}
          phoneUi={phoneUi}
          busy={busy}
          error={error}
          version={version}
          devEndpoints={devEndpoints}
          start={settingsPage}
          machineChats={{ list: chats, open: openChatFromSettings }}
          home={() => closeSettings()}
          pair={() => {
            closeSettings();
            setPairing(true);
          }}
          connect={(pairId) => {
            void run(() => runtime.connect(pairId));
          }}
          remove={(pairId) => {
            void run(async () => {
              await runtime.unpair(pairId);
              // that computer's saved chats go with it
              forgetPairRows(pairId);
              await rowCache?.prune((key) => (JSON.parse(key) as string[])[1] !== pairId).catch(() => undefined);
              await list.cache?.prune((key) => (JSON.parse(key) as string[])[1] !== pairId).catch(() => undefined);
              await pictureCache?.prune((key) => (JSON.parse(key) as string[])[1] !== pairId).catch(() => undefined);
            });
          }}
          signOut={() => {
            void run(leave);
          }}
          // the account is deleted at the service first; the phone then leaves as Sign out does (a failure stays on the Delete card); busy meanwhile, and not signed out if another account's by then
          deleteAccount={async (confirm) => {
            const key = owner(runtime.snapshot());
            setBusy(true);
            try {
              await deleteThenLeave(confirm, {
                deleteAccount: (c) => runtime.deleteAccount(c),
                leave: async () => (key === owner(runtime.snapshot()) ? leave() : undefined),
              });
            } finally {
              setBusy(false);
            }
          }}
        />
      );
    if (route.kind === 'newChat')
      return (
        <NewChat
          key={state.generation}
          runtime={runtime}
          media={media!}
          back={() => setCreatingFor(undefined)}
          drafts={drafts.of(newChatKey)}
          focus={landing.focus}
          sending={(text, startId, pictures) => setStarting(text !== null && startId ? { id: startId, text, pictures } : null)}
          open={(id, sent) => {
            drafts.of(newChatKey).set('');
            setStarting(null);
            setFirst({ chatId: id, owner: JSON.stringify([state.user?.id, state.selectedPair]), ...sent });
            setCreatingFor(undefined);
            showChat(id);
            void refresh();
          }}
        />
      );
    if (route.kind === 'starting') return <Starting text={starting!.text} pictures={starting!.pictures} back={() => setStarting(null)} />;
    if (route.kind === 'answer')
      return (
        <ReviewHost
          runtime={runtime}
          chats={chats!}
          id={reviewId!}
          go={setReviewId}
          openChat={showChat}
          askChanges={showChat}
          done={() => {
            void refresh();
          }}
        />
      );
    if (route.kind === 'scheduled') return <Scheduled key={state.generation} runtime={runtime} back={() => setScheduled(false)} />;
    if (route.kind === 'pairing')
      return (
        <PairingRoute {...{ runtime, user: state.user, name: phoneName, host, setOpen: setPairing }} signOut={() => void run(leave)} />
      );
    if (route.kind === 'home')
      return (
        <HomeRoute
          {...{
            state,
            runtime,
            push,
            pushUi,
            devEndpoints,
            chats,
            started,
            hostWaiting,
            uninvited: invite === 'uninvited',
            error,
            busy,
            pulling,
          }}
          folds={homeFolds}
          fresh={list.fresh}
          waiting={waiting}
          hasMedia={!!media}
          hasMomo={!!(momoAllowed && momoSetup)}
          hasAway={!!awayNewChat}
          hasMore={!!moreChats}
          loadingMore={loadingMore}
          act={homeAct}
        />
      );
    // the chat and its screens: what is left are the routes that carry their chat
    const chat = route.chatId;
    if (route.kind === 'review')
      return <Review key={`${state.generation}:${chat}`} runtime={runtime} chatId={chat} {...chatNav} back={() => setReviewing(false)} />;
    if (route.kind === 'terminal')
      return <Terminal key={`${state.generation}:${chat}`} runtime={runtime} chatId={chat} {...chatNav} back={() => setMirror(null)} />;
    if (route.kind === 'chat')
      return (
        <ScreenBoundary key={`${state.user?.id}:${lastPair.current}:${chat}`} back={closeChat}>
          <ChatRoute
            pair={state.selectedPair ?? lastPair.current}
            media={media}
            {...chatNav}
            changed={() => void refresh()}
            archived={() => (closeChat(), void refresh())}
            where={() => setSettings(true)}
            runtime={runtime}
            chatId={chat}
            askChanges={ask}
            {...{ push, pushUi }}
            first={first?.chatId === chat && first.owner === JSON.stringify([state.user?.id, state.selectedPair]) ? first : undefined}
            back={closeChat}
            // the chat's own rows and draft, kept by the computer it is on: while that computer is away, the last one selected
            historyKey={draftKey(state.user?.id, lastPair.current, chat)}
            rowCache={rowCache}
            offline={waiting}
            drafts={drafts.of(draftKey(state.user?.id, lastPair.current, chat))}
          />
        </ScreenBoundary>
      );
  };
  return (
    <ScreenFrame>
      <StatusBar style="auto" />
      {/* one Mac link for every screen: a gray glyph, an Offline chip, a queued note or a disabled approval read it */}
      <MacLinkProvider state={state} runtime={runtime}>
        {/* a chat named in a reply opens on top of the one it is in, as a chat opened from the list */}
        <ChatLinkContext.Provider value={openLinkedChat}>
          <NativeStack routes={stackOf(nav)} render={render} popped={popped} />
        </ChatLinkContext.Provider>
      </MacLinkProvider>
    </ScreenFrame>
  );
}
