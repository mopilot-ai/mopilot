// The home screen at the bottom of the stack: Claude's Chats page, with the drawer behind it, the header's drawer circle, the list (which starts with + New session, as Claude's Sessions does), and the search circle at the bottom left.
import { useState, type ReactNode } from 'react';
import { RefreshControl, ScrollView, View } from 'react-native';
import { type ChatSearch, ChatSearchProvider } from '../components/ChatSearch';
import { GlassCircle } from '../components/Glass';
import { DrawerFrame } from '../components/Drawer';
import { HomeOverlayContext } from '../components/HomeOverlay';
import { Icon } from '../components/Icon';
import { PageHeader } from '../components/PageHeader';
import { useScreenInsets } from '../components/ui';
import { useTheme } from '../theme';
import { usePerfRender } from '../perfLog';

/** The drawer's content, given the way to close it; absent until there is an account to show it for (signing in, loading). */
export type HomeDrawer = (leave: () => void) => ReactNode;

export function Home({
  drawer,
  refresh,
  children,
}: {
  drawer?: HomeDrawer;
  refresh?: { pulling: boolean; run: () => void };
  children: ReactNode;
}) {
  usePerfRender('Home');
  const theme = useTheme();
  const insets = useScreenInsets();
  const [wanted, setOpen] = useState(false);
  // what the list puts over the whole screen (its row menu), outside the scroll content
  const [overlay, setOverlay] = useState<ReactNode>(null);
  // a drawer that goes away (sign-out) is closed, so the next account does not find it open
  if (wanted && !drawer) setOpen(false);
  const open = wanted && !!drawer;
  const close = () => setOpen(false);
  const page = (search: ChatSearch) => (
    <View style={{ flex: 1, backgroundColor: theme.bg }}>
      {drawer && (
        <PageHeader
          title="Chats"
          left={
            <GlassCircle label="Open menu" onPress={() => setOpen(true)}>
              <Icon name="line.3.horizontal" glyph="≡" size={20} color={theme.ink} />
            </GlassCircle>
          }
        />
      )}
      <ScrollView
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={{ paddingBottom: drawer ? 96 : 24 }}
        refreshControl={refresh ? <RefreshControl refreshing={refresh.pulling} onRefresh={refresh.run} /> : undefined}
      >
        {children}
      </ScrollView>
      {/* search at the bottom left; New session is the list's first row */}
      <View
        pointerEvents="box-none"
        style={{ position: 'absolute', left: 24, right: 24, bottom: 16, flexDirection: 'row', justifyContent: 'space-between' }}
      >
        {drawer && search.listed ? (
          <GlassCircle label={search.open ? 'Close search' : 'Search chats'} onPress={search.open ? search.hide : search.show}>
            <Icon name={search.open ? 'xmark' : 'magnifyingglass'} glyph={search.open ? '×' : '⌕'} size={20} color={theme.ink} />
          </GlassCircle>
        ) : (
          <View />
        )}
      </View>
      {overlay}
    </View>
  );
  // the provider wraps the drawer too, so the drawer's search circle opens the list's search
  return (
    <HomeOverlayContext.Provider value={setOverlay}>
      <ChatSearchProvider>
        {(search) =>
          drawer ? (
            <DrawerFrame open={open} close={close} show={() => setOpen(true)} drawer={drawer(close)}>
              {page(search)}
            </DrawerFrame>
          ) : (
            // Chats draws under the status bar and home indicator for its drawer; without one its page keeps clear of them itself
            <View style={[{ flex: 1, backgroundColor: theme.bg }, insets]}>{page(search)}</View>
          )
        }
      </ChatSearchProvider>
    </HomeOverlayContext.Provider>
  );
}
