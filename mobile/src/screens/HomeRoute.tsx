// The chats home as the app's stack draws it, held still while nothing it shows has changed (#4986): the stack's other screens and the app's own state change often, and the root draws this route from props that are the same each time; it is memoized on them, with the app's handlers passed as one object of stable forwarders (`homeActions`), so tapping a chat row does not draw the list that is about to be covered.
import { memo, type MutableRefObject, useMemo, useRef } from 'react';
import { Text, View } from 'react-native';
import type { MobileRuntime, MobileSnapshot } from '../contracts';
import { useStyles } from '../components/ui';
import { connectingNow } from '../macLink';
import type { PushController } from '../push/controller';
import type { usePushUi } from '../push/usePushUi';
import { withHostWaiting, withStarted } from '../remote/useHostWaiting';
import { ChatList } from './ChatList';
import { Home } from './Home';
import { HomeDrawerPanel } from './HomeDrawer';
import { headed, HomeStatus } from './HomeStatus';

/** What the home does in the app; each is the app's current handler, reached through one stable function. */
export type HomeActions = {
  open: (chatId: string) => void;
  review: (chatId: string) => void;
  machine: (machineId: string) => void;
  showChat: (chatId: string) => void;
  momo: () => void;
  scheduled: () => void;
  settings: () => void;
  computers: () => void;
  createChat: (accountId: string) => void;
  /** The way to start a chat while the Mac is away (a machine that can take it), or nothing; asked through `hasAway`. */
  away: () => void;
  pair: () => void;
  signOut: () => void;
  run: (fn: () => Promise<void>) => Promise<void>;
  refresh: () => void;
  loadMore: () => void;
};

/** The forwarders of `latest`: the same functions for the life of the screen, each calling what `latest` holds now. */
export function homeActions(latest: MutableRefObject<HomeActions>): HomeActions {
  const forward = <K extends keyof HomeActions>(name: K) =>
    ((...args: never[]) => (latest.current[name] as (...a: never[]) => unknown)(...args)) as HomeActions[K];
  return {
    open: forward('open'),
    review: forward('review'),
    machine: forward('machine'),
    showChat: forward('showChat'),
    momo: forward('momo'),
    scheduled: forward('scheduled'),
    settings: forward('settings'),
    computers: forward('computers'),
    createChat: forward('createChat'),
    away: forward('away'),
    pair: forward('pair'),
    signOut: forward('signOut'),
    run: forward('run'),
    refresh: forward('refresh'),
    loadMore: forward('loadMore'),
  };
}

/** One stable `HomeActions` for a screen whose handlers are new each render. */
export function useHomeActions(current: HomeActions): HomeActions {
  const latest = useRef(current);
  latest.current = current;
  return useMemo(() => homeActions(latest), []);
}

type Chats = Parameters<typeof withStarted>[0];

export type HomeRouteProps = {
  state: MobileSnapshot;
  runtime: MobileRuntime;
  push?: PushController;
  pushUi: ReturnType<typeof usePushUi>;
  devEndpoints?: { relayUrl: string; accountOrigin: string };
  chats: Chats;
  started: Parameters<typeof withStarted>[1];
  hostWaiting: Parameters<typeof withHostWaiting>[1];
  folds: React.ComponentProps<typeof ChatList>['folds'];
  /** The list is as the Mac last said (not stale while it is read again). */
  fresh: boolean;
  /** A computer being waited for, or a list painted from disk: the chats can be opened and followed when it returns. */
  waiting: boolean;
  uninvited: boolean;
  error: string | null;
  busy: boolean;
  pulling: boolean;
  hasMedia: boolean;
  hasMomo: boolean;
  hasAway: boolean;
  hasMore: boolean;
  loadingMore: boolean;
  act: HomeActions;
};

export const HomeRoute = memo(function HomeRoute(p: HomeRouteProps) {
  const styles = useStyles();
  const { state, act } = p;
  const online = state.phase === 'online';
  const offline = !online || !p.fresh;
  const shown = useMemo(() => withHostWaiting(withStarted(p.chats, p.started), p.hostWaiting), [p.chats, p.started, p.hostWaiting]);
  const accountId = state.user?.id;
  const away = p.hasAway ? act.away : undefined;
  const create = accountId && p.hasMedia && online ? () => act.createChat(accountId) : away;
  return (
    <Home
      drawer={
        headed(state)
          ? (leave: () => void) => (
              <HomeDrawerPanel
                user={state.user!}
                chats={p.chats}
                offline={offline}
                leave={leave}
                openChat={online || p.waiting ? act.showChat : undefined}
                momo={p.hasMomo ? act.momo : undefined}
                scheduled={online ? act.scheduled : undefined}
                settings={act.settings}
                newChat={create && !p.busy ? create : away}
              />
            )
          : undefined
      }
      refresh={online ? { pulling: p.pulling, run: act.refresh } : undefined}
    >
      <View>
        <HomeStatus
          uninvited={p.uninvited}
          state={state}
          runtime={p.runtime}
          busy={p.busy}
          error={p.error}
          run={act.run}
          push={p.push}
          pushUi={p.pushUi}
          devEndpoints={p.devEndpoints}
          pair={act.pair}
          signOut={act.signOut}
          listed={!!p.chats}
          newSession={away}
        />
        {(online || ((state.phase === 'offline' || state.phase === 'ready') && !!p.chats)) && (
          <ChatList
            chats={shown}
            offline={offline}
            failed={!!p.error}
            busy={p.busy}
            folds={p.folds}
            open={act.open}
            computers={act.computers}
            machine={act.machine}
            newChat={create}
            review={online && p.fresh ? act.review : undefined}
            rowMenu={online && p.fresh ? { runtime: p.runtime, changed: act.refresh } : undefined}
            openable={online || p.waiting}
            more={p.chats && p.hasMore && online ? { loading: p.loadingMore, load: act.loadMore } : undefined}
          />
        )}
        {connectingNow(state) && (
          <Text style={[styles.muted, { paddingHorizontal: 24, paddingTop: 16 }]}>Connecting to your computer…</Text>
        )}
      </View>
    </Home>
  );
});
