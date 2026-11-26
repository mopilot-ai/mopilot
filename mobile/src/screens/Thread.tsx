// A followed chat, with its snapshot, live events, requests and retryable composer.
import { type ReactNode, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Keyboard, ScrollView, Text, View } from 'react-native';
import { useTheme } from '../theme';
import type { MobileRuntime } from '../contracts';
import { ErrorLine, useStyles } from '../components/ui';
import { markChat, markSendEvent } from '../launchTrace';
import { EarlierRow } from '../components/EarlierRow';
import { ChatPlanSheet } from '../components/PlanSheet';
import { ChatComposer } from '../components/ChatComposer';
import { useThreadComposer } from '../components/useThreadComposer';
import { SelectionActions } from '../sideChat';
import type { DraftHandle } from '../presentation/drafts';
import { useChatHeader } from '../components/ChatHeader';
import { TranscriptBlocks } from '../components/TranscriptBlocks';
import { ChangesChip, TurnLine } from '../components/TurnLine';
import { cardKey, type CardData } from '../components/RequestCard';
import { ChatCards } from '../components/ChatCards';
import { useCards } from '../remote/useCards';
import { savedCount } from '../presentation/heldRows';
import { displayRows, keyedRows, type Data, type Thread as ThreadState } from '../presentation/thread';
import { tick, type Clock } from '../presentation/toolRuns';
import { createFollowFeed } from '../presentation/followFeed';
import { expectReply, watchFor } from '../presentation/liveWatchDevice';
import { FOLLOW_ROWS, followRequest } from '../presentation/follow';
import type { Media } from '../platform/media';
import { ChatAddSheet } from '../components/ChatAddSheet';
import { useOwnedRequest } from '../remote/useOwnedRequest';
import { notesIn, useChatControls } from '../remote/useChatControls';
import { useSurface } from '../remote/useSurface';
import { ChatModelSheets, type ModelSheetOpen } from '../components/ChatModelSheet';
import { forgetIfGone, isGone } from '../remote/useChatRows';
import { LoadFailure } from '../components/LoadFailure';
import type { PagedChatCache } from '../remote/pageCache';
import { useAttachments } from '../remote/useAttachments';
import { useEarlier } from '../remote/useEarlier';
import { useChangeCounts } from '../remote/useChangeCounts';
import { useCatchUpWhenBack } from '../catchUp';
import { useBlockWindow } from '../remote/useBlockWindow';
import { useShownRows } from '../remote/useShownRows';
import { useSwapPhase } from '../remote/useSwapPhase';
import { useFollowEnd } from '../remote/useFollowEnd';
import { useQuiet } from '../remote/useQuiet';
import { QueuedMessages, queueCalls } from '../components/QueuedMessages';
import { MacQueue } from '../components/MacQueue';
import { lineDropper, useQueueLine } from '../presentation/queueLine';
import { retryTurn } from '../presentation/retryTurn';
import { messagePictures, messageReady } from '../presentation/messagePictures';
import { usePendingMessages, usePreviewedRows } from '../presentation/useSentMessages';
import { Notice } from '../components/Notice';
import { useSavedLine } from '../components/SavedLine';
import { lostInFlight, unconfirmedNotice, type Unconfirmable } from '../remote/unconfirmed';
import { useUnconfirmed } from '../remote/useUnconfirmed';
import type { QueuedSend } from '../outbox';
import { tailOf } from '../presentation/workingLine';
import { copyText } from '../platform/clipboard';
import { kitQueued, machineQueuedLine, macScreens } from '../remote/hostChat';
import { explain } from '../remote/client';
import { useHostRuntime } from '../remote/useHostRuntime';
import { useStopping } from '../remote/useStopping';
import { FollowOverlays } from '../components/FollowOverlays';
import { initialSent, withSent, unrecordedQueue, type Sent, type FirstMessage } from '../presentation/sentMessages';
export function Thread({
  runtime: base,
  chatId,
  back,
  drafts,
  media,
  review: reviewOffered,
  ownHarness,
  historyKey,
  rowCache,
  offline: macAway = false,
  terminal: terminalOffered,
  pinned,
  changed,
  archived,
  where,
  backLabel,
  queued: macQueued = [],
  notify,
  title,
  subtitle,
  hostId,
  first,
  askChanges = null,
}: {
  runtime: MobileRuntime;
  chatId: string;
  back: () => void;
  /** The chat's draft: its text lives outside this screen, so a key typed re-renders only the composer. */
  drafts: DraftHandle;
  /** Photos, camera and voice notes; absent where the app has none, and the controls are then hidden. */
  media?: Media;
  /** Opens the chat's changes; absent where review is not offered. */
  review?: () => void;
  /** The agent the chat list says the chat runs on, so a move to another agent that waits can be called off. */
  ownHarness?: string;
  /** Where the chat's rows are kept for its offline page (the account, computer and chat); absent keeps nothing. */
  historyKey?: string;
  /** The sealed copy of those rows on this phone, so a chat opened before paints from disk; absent keeps only the memory copy. */
  rowCache?: PagedChatCache | null;
  /** The computer is away and being waited for: the chat shows what it last showed, and what is sent waits for the computer. */
  offline?: boolean;
  /** Opens the read-only terminal; absent where the app has none. */
  terminal?: () => void;
  /** The chat is pinned in the list; `changed` reads the list again after a pin or rename. */
  pinned?: boolean;
  changed?: () => void;
  /** The chat was archived from its menu: leave it. */
  archived?: () => void;
  /** Opens where the chat runs. */
  where?: () => void;
  /** What Back is read as. */
  backLabel?: string;
  /** This chat's messages the computer has not accepted yet. */
  queued?: QueuedSend[];
  notify?: ReactNode; // a card for the end of a finished reply: the app asks about notifications there, once
  /** The chat's title and where it runs, for the navigation bar. */
  title?: string;
  subtitle?: string;
  /** The Host the chat runs on, when it is not the Mac itself. */
  hostId?: string;
  /** The message this chat was started with, shown from the first frame, and the line the computer added when it started (a warning). */
  first?: FirstMessage;
  /** Opened from the quick review's "Ask for changes" on the plan card of this key: that plan waits while the field asks what should change in it. */
  askChanges?: string | null;
}) {
  const styles = useStyles();
  // a machine's chat while the Mac is away: read from and written to the machine itself (X4)
  const { runtime, offline } = useHostRuntime(base, hostId, macAway, chatId);
  const { review, terminal } = macScreens(base, hostId, chatId, { review: reviewOffered, terminal: terminalOffered });
  // a message waiting for (or refused by) the machine is in the phone's own outbox: it shows beside the Mac's queue, in the same words
  const via = runtime !== base && base.direct && hostId ? { direct: base.direct, machineId: hostId } : null;
  const queued = via ? [...macQueued, ...kitQueued(via.direct.chat, via.machineId, chatId)] : macQueued;
  const request = useOwnedRequest(runtime);
  // the chat is followed first: the reads that wait for it (controls, changes) start once chat.follow is on the wire
  const [followSent, setFollowSent] = useState(false);
  const rowKeys = useRef({ historyKey, rowCache }); // read when a follow is refused; a late cache is no reason to follow again
  rowKeys.current = { historyKey, rowCache };
  const [modelSheet, setModelSheet] = useState<ModelSheetOpen>(null);
  const files = useAttachments(request, historyKey);
  const earlier = useEarlier(request, chatId, rowCache?.pages ?? null, rowCache?.pages ? historyKey : null);
  const [thread, setThread] = useState<ThreadState | null>(null);
  const threadRef = useRef(thread);
  threadRef.current = thread;
  const settings = useChatControls(request, chatId, followSent, notesIn(thread));
  // a stop or an answer that was in flight as the connection went: the Mac may have taken it; the notice goes when the chat shows what became of it
  const unconfirmed = useUnconfirmed(
    JSON.stringify([
      thread?.session.turnStatus,
      Array.isArray(thread?.session.cards) ? (thread.session.cards as CardData[]).map(cardKey) : [],
    ]),
  );
  const [error, setError] = useState<string | null>(null);
  // a control takes back the line it set, and only that one: another control's line stays (`lost`: the follow's own failure)
  const dropLine = lineDropper(setError);
  const [lost, setLost] = useState<string | null>(null);
  const gone = isGone(lost ?? error);
  const [refresh, setRefresh] = useState<() => void>(() => () => undefined);
  const onScreen = useRef(0);
  const [busy, setBusy] = useState(false);
  const cards = useCards(thread?.session.cards, (params, handled) => action('card.answer', params, 'answer', handled), askChanges);
  // a recording or transcript in the voice note keeps the attachment menu open
  const [voiceBusy, setVoiceBusy] = useState(false);
  const [adding, setAdding] = useState(false);
  const follow = useFollowEnd(chatId, cards.waiting, earlier.release);
  useCatchUpWhenBack(offline);
  const theme = useTheme();
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  // messages sent from this page whose record the computer has not shown yet (the first one is the chat's start)
  const [sent, setSent] = useState<Sent[]>(() => initialSent(first, queued));
  useEffect(() => {
    setThread(null);
    setFollowSent(false);
    setError(null);
    setLost(null);
    cards.reset();
    // while the computer is away nothing is followed; it is read again from the start when the computer is back
    if (offline) return;
    markChat('open');
    const feed = createFollowFeed({
      // a read again covers the rows on screen, so what was paged back above the first snapshot is part of it
      read: () => {
        markChat('follow-sent');
        return followRequest(runtime, chatId, 'chat.follow', Math.max(FOLLOW_ROWS, onScreen.current)).then(
          (answer) => (markChat('follow-answered'), answer),
        );
      },
      watch: watchFor(runtime, chatId), // the net under the live events (liveWatch.ts)
      final: isGone, // a first read that failed is read again by itself, unless the chat is gone
      subscribe: (handle) =>
        runtime.onEvent((event) => {
          if (event.chatId !== chatId) return;
          markSendEvent(event, { pairId: runtime.snapshot().selectedPair, chatId });
          handle(event);
        }),
      on: {
        thread: (value, reread) => {
          markChat('rows-shown');
          setLost(null);
          if (reread || !threadRef.current) earlier.reread(threadRef.current, value);
          setThread(value);
        },
        failed: (message, quiet) => {
          // a chat read before keeps its rows; the first read that fails says why
          if (!quiet) forgetIfGone(message, rowKeys.current.historyKey, rowKeys.current.rowCache);
          setLost(explain(message));
        },
      },
    });
    setRefresh(() => feed.refresh);
    feed.start();
    setFollowSent(true);
    return () => {
      feed.stop();
      void followRequest(runtime, chatId, 'chat.unfollow').catch(() => {
        /* Cleanup is best effort after the view is retired. */
      });
    };
  }, [runtime, chatId, cards.reset, earlier.reread, offline]);
  async function action(method: string, params: Data, kind: Unconfirmable, handled?: (e: unknown) => boolean) {
    setBusy(true);
    setError(null);
    const lost = unconfirmed.begin();
    try {
      await runtime.request(method, { chatId, ...params });
    } catch (e: unknown) {
      if (mounted.current) {
        if (!handled?.(e)) {
          if (lostInFlight(e)) lost(kind);
          else setError(explain(e));
        }
        setBusy(false);
      }
      return false;
    }
    if (mounted.current) setBusy(false);
    return true;
  }
  /** Sends the draft with the skills the composer holds; false when nothing went. */
  function send(skills: string[]): boolean {
    const text = drafts.get();
    if (!messageReady(text, files.items)) return false; // files alone are a message
    const pictures = messagePictures(files.items);
    try {
      const id = runtime.send(chatId, text, files.ids, skills, undefined, pictures); // queued under one send id; a refusal can be sent again or cancelled
      setSent((old) =>
        withSent(
          old,
          rowsRef.current,
          text,
          id,
          held.map((h) => h.id),
          pictures,
          pictures.length ? runtime.messageIdentity?.('chat.send', chatId, id) : undefined,
        ),
      );
      follow.pin(pictures.length ? undefined : text), expectReply(chatId); // pinned, as in Claude for iOS; a message with pictures (over its words) lands without the words' rise
      Keyboard.dismiss();
    } catch (e: unknown) {
      setError(explain(e));
      return false;
    }
    unconfirmed.clear();
    setError(null);
    drafts.clear(text);
    files.clear();
    cards.sent();
    return true;
  }
  // a chat opened: nothing paged back from another one (a read again resets it with the new snapshot, which covers what was paged)
  useEffect(() => {
    void chatId;
    earlier.reset();
  }, [chatId, earlier.reset]);
  useEffect(() => earlier.fill(thread), [earlier.fill, thread]);
  // an older row is keyed by its identity, the key it has in the snapshot too, so a page joined above (with a message that repeats one shown) leaves the keys of the rows below as they were and a row that moves from the snapshot to the rows above is not mounted again
  const all = useMemo(
    () => (thread ? [...earlier.rows.map(earlier.item), ...keyedRows(displayRows(thread))] : []),
    [thread, earlier.rows, earlier.item],
  );
  // saved rows only: counting a live row asked for one more row at every read again (and the net then read again every 4 s for ever)
  onScreen.current = earlier.rows.length + (thread ? savedCount(thread) : 0);
  const rows = usePreviewedRows(runtime, chatId, all, sent, queued);
  const rowsRef = useRef(rows);
  rowsRef.current = rows;
  // your message stays as a bubble until the computer's record of it is among the rows
  const { held, linked, visibleQueue, picturesFor } = usePendingMessages(setSent, sent, thread, rows, queued);
  const queueLine = useQueueLine(held, setError);
  const queue = queueCalls(runtime);
  const status = thread?.session.turnStatus;
  const running = ['running', 'inProgress', 'awaitingUser'].includes(status as string);
  const stopping = useStopping(running, () => action('chat.stop', {}, 'stop'));
  const composer = useThreadComposer({
    send,
    cards,
    files,
    settings,
    media,
    running,
    busy,
    stopping,
    voiceBusy,
    setVoiceBusy,
    setModelSheet,
    setAdding,
  });
  const quiet = useQuiet(thread);
  // what the phone saw of the turn: when it began and how long it took, which the Mac does not send. It is set after the status changes, so in the commit where a turn has just ended it still says the turn ran: the end line is kept on `clock.active`, or it would leave for a commit and the chat dip by its height (#4826)
  const [clock, setClock] = useState<Clock>(null);
  const loaded = thread !== null;
  useEffect(() => {
    setClock((old) => (loaded ? tick(old, status, Date.now()) : null));
  }, [loaded, status]);
  // what ends the transcript names the working line's activity; the thinking copy grows from when it last changed
  const tail = useMemo(() => tailOf(rows), [rows]);
  // a step the transcript leaves out (the wrap-up) still ends the turn's reply: what follows it is not the reply
  const tailKey = all.at(-1)?.key ?? '';
  const [since, setSince] = useState(() => Date.now());
  useEffect(() => {
    void tailKey; // a new row ends the transcript
    void running; // or the turn starts or resumes
    setSince(Date.now());
  }, [tailKey, running]);
  const lines = useChangeCounts(runtime, request, chatId, !!review, loaded && !running);
  const pending = [...queued, ...held];
  const shownRows = useShownRows({ rows, loaded, running, historyKey, rowCache, counts: lines, linked, pending });
  const { saved, shown, changes, turn, waiting, list, folded, toggle } = shownRows;
  rowsRef.current = shown;
  const win = useBlockWindow(list.blocks, chatId, !thread);
  const savedLine = useSavedLine(chatId, !thread && !!rowCache?.pages && shown.length > 0 && (offline || !!lost));
  const phase = useSwapPhase(thread !== null);
  const canPageBack = !!thread && !!earlier.cursor(thread);
  const working = useSurface(request, chatId, status === 'running' || status === 'inProgress', rows.length);
  // the header's sheets are drawn last, over the page body (drawn first they would sit under it)
  const header = useChatHeader({
    request,
    chatId,
    title,
    subtitle: working ?? subtitle,
    back,
    backLabel,
    review,
    terminal,
    lines,
    pinned,
    changed,
    archived,
    where,
    ...settings,
    hostId,
  });
  return (
    <View style={styles.page}>
      {header.bar}
      <View style={[styles.body, { padding: 16, paddingTop: 0, paddingBottom: 4, gap: 8 }]}>
        <ErrorLine text={error ?? lost} />
        {unconfirmed.kind && <Notice {...unconfirmedNotice(unconfirmed.kind)} />}
        {!thread &&
          !(error ?? lost) &&
          !saved.length &&
          // no loading text (a chat opens like Claude's); a quiet spinner says the page is not blank by mistake
          (offline ? (
            <Text accessibilityLiveRegion="polite" style={styles.muted}>
              {'Waiting for your computer…'}
            </Text>
          ) : (
            <ActivityIndicator accessibilityLabel="Loading chat" color={theme.ink2} style={{ alignSelf: 'center', marginTop: 24 }} />
          ))}
        {/* never an empty body: until the Mac's rows (or the cached ones) are on screen, the page says what it is waiting for */}
        <LoadFailure empty={!thread && !offline} failed={!!(error ?? lost)} lost={!!lost} gone={gone} retry={refresh} />
      </View>
      <View style={{ flex: 1 }}>
        {/* over the list, not above it nor in it: the saved rows are bottom-pinned, and its going must not move them */}
        {savedLine.line}
        <ScrollView
          ref={follow.ref}
          contentContainerStyle={[styles.body, { padding: 16, paddingTop: 16 + savedLine.room, gap: 8, minHeight: follow.reserve }]}
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="on-drag"
          scrollEventThrottle={32}
          {...follow.props}
          {...earlier.listProps(thread, follow.props, { ...win, holds: follow.reserve === undefined })}
          // a page joined above keeps the row being read where it is; the control above the rows (with its error) is the first child
          maintainVisibleContentPosition={follow.pinArmed ? undefined : { minIndexForVisible: 1 }}
        >
          {(canPageBack || win.hidden > 0) && <EarlierRow {...earlier.row(thread, win)} />}
          {/* only the reply that ends a working turn is still being written; one followed by steps, or by a question for you, is finished */}
          <SelectionActions {...{ drafts, request, chatId, hostId }} controls={settings.controls} usable={!gone && !!thread}>
            <TranscriptBlocks
              blocks={win.shown}
              streamingKey={status === 'running' || status === 'inProgress' ? tailKey : null}
              phase={phase}
              request={request}
              chatId={chatId}
            />
          </SelectionActions>
          {/* cache-first: the rows the chat last showed, while its computer is away */}
          {!!first?.warning && <Notice text={first.warning} />}
          {thread && !thread.items.length && !thread.history.length && !queued.length && !waiting.length && (
            <Text style={styles.muted}>No messages yet.</Text>
          )}
          <MacQueue
            picturesFor={picturesFor}
            runtime={runtime}
            chatId={chatId}
            session={thread?.session}
            running={running}
            hiddenIds={held.filter((h) => !unrecordedQueue([h], linked, rows).length).map((h) => h.id)}
            removed={(id) => setSent((old) => old.filter((s) => s.remoteId !== id))}
            draft={drafts.get}
            setDraft={drafts.set}
            fail={queueLine.fail}
            settle={queueLine.settle}
          />
          <QueuedMessages
            items={visibleQueue}
            queuedLine={via ? machineQueuedLine(via.direct, via.machineId) : undefined}
            picturesFor={picturesFor}
            {...queue}
            cancel={(id) => {
              if (queue.cancel(id)) setSent((old) => old.filter((s) => s.id !== id));
            }}
            edit={(id, text) => {
              if (!queue.edit(id, text)) return false;
              setSent((old) =>
                withSent(
                  old.filter((s) => s.id !== id),
                  rowsRef.current,
                  text,
                  id,
                  held.map((h) => h.id),
                  picturesFor(id) ?? [],
                  linked.find((send) => send.id === id)?.nativeId,
                ),
              );
              return true;
            }}
          />
          <ChatCards cards={cards} />
          {(running || list.activity > 0 || clock?.active || clock?.took != null || clock?.ended) && (
            // only the steady "Waiting for you" is announced; a running clock would be read out every second
            <View accessibilityLiveRegion={status === 'awaitingUser' ? 'polite' : 'none'}>
              <TurnLine
                clock={clock}
                quiet={quiet}
                tail={tail}
                since={since}
                // the saved rows may be old (a newer turn, one still running): only the Mac's own rows offer copy and retry
                copy={thread && turn.reply ? () => void copyText(turn.reply!) : undefined}
                retry={
                  thread && turn.you
                    ? retryTurn({ runtime, chatId, text: turn.you, setSent, rows: () => rowsRef.current, held, pin: follow.pin, setError })
                    : undefined
                }
                state={!running ? 'done' : status === 'awaitingUser' ? 'waiting' : 'working'}
                folded={folded}
                toggle={toggle}
              />
            </View>
          )}
          {thread && !running && !!turn.reply && notify}
          <View {...follow.endMarker} />
        </ScrollView>
        <FollowOverlays scroller={follow.ref} away={follow.awayStore} ready={!!thread} jump={follow.jump} />
      </View>
      {!running && changes && changes.files > 0 && (
        <ChangesChip added={changes.added} removed={changes.removed} open={thread ? review : undefined} />
      )}
      {/* always there, as in Claude for iOS: before the live load answers (cached rows, a slow Mac) or while offline, a message goes to the outbox and is sent in order; Stop and the model pill appear once the chat is followed */}
      {!gone && <ChatComposer {...{ drafts, request, chatId, media }} {...composer} />}
      <ChatAddSheet
        {...{ media, files, request, drafts, where, controls: settings.controls, open: adding }}
        onClose={() => setAdding(false)}
        openPermission={() => setModelSheet('model')}
      />
      {header.sheets}
      <ChatModelSheets
        request={request}
        chatId={chatId}
        controls={settings.controls}
        reload={settings.reload}
        ownHarness={ownHarness}
        failed={setError}
        clear={dropLine}
        sheet={modelSheet}
        setSheet={setModelSheet}
      />
      <ChatPlanSheet cards={cards} />
    </View>
  );
}
