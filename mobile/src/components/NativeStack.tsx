// Shows the screen stack natively: iOS push and pop, the edge swipe back, and page sheets pulled down to close.
import type { ReactNode } from 'react';
import { useRef } from 'react';
import { Platform } from 'react-native';
import { ScreenStack, ScreenStackItem } from 'react-native-screens';
import { useTheme } from '../theme';
import { useScreenInsets } from './ui';
import type { Route } from '../stack';

/**
 * `popped` runs when the system took a screen away (a swipe back, a sheet pulled down), so the app's state follows.
 * It runs only for a route that is still the one on screen: a dismissal reported after the app already moved on (a
 * screen it closed itself, then another opened) must not close what is open now.
 */
export function NativeStack({
  routes,
  render,
  popped,
}: {
  routes: Route[];
  render: (route: Route) => ReactNode;
  popped: (route: Route) => void;
}) {
  const colors = useTheme();
  const insets = useScreenInsets();
  const current = useRef(routes);
  current.current = routes;
  const dismissed = (route: Route) => {
    if (current.current.some((open) => open.key === route.key)) popped(route);
  };
  return (
    <ScreenStack style={{ flex: 1 }}>
      {routes.map((route) => (
        <ScreenStackItem
          key={route.key}
          screenId={route.key}
          // every screen draws its own bar for now; the system still animates the push and the swipe back
          headerConfig={{ hidden: true }}
          // a sheet is iOS's page sheet (a card over the list, pulled down to close). Not formSheet: that lays its content
          // out with no height of its own, and on iOS 27 New chat's scroll view then covered the sheet's Cancel and title
          stackPresentation={route.sheet ? 'modal' : 'push'}
          // a pushed screen keeps clear of the status bar and home indicator; Chats draws under them for its drawer and keeps
          // clear itself, and an iOS page sheet starts below the status bar already (Android shows a sheet full screen)
          contentStyle={[
            { flex: 1, backgroundColor: colors.bg },
            route.kind !== 'home' && (!route.sheet || Platform.OS === 'android') && insets,
          ]}
          onDismissed={() => dismissed(route)}
        >
          {render(route)}
        </ScreenStackItem>
      ))}
    </ScreenStack>
  );
}
