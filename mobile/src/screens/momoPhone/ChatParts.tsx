// MoMo chat's phone chrome: the header pill with its state dot, the home banner, waiting and unsettled messages, and the floating Chat · Tasks · Notes pill.
import { say } from '../../momoPhone/say';
import { Text, useWindowDimensions, View } from 'react-native';
import { Tap } from '../../ui/ds/Tap';
import { useTheme } from '../../theme';
import { typo } from '../../typography';
import type { PhoneView } from '../../momoPhone/types';
import { deliveryProblems, headerPill, homeBanner, sourceProblems } from '../../momoPhone/viewModels';
import { Boundary } from './Boundary';
import { Actions, Body, Card, StateDot, Title, type Act } from './parts';

export type Tab = 'chat' | 'tasks' | 'notes';
export const TABS: { key: Tab; label: string }[] = [
  { key: 'chat', label: 'chat' },
  { key: 'tasks', label: 'tasks' },
  { key: 'notes', label: 'notes' },
];

/** "MoMo · Studio" with the dot; a tap opens Where MoMo runs. */
export function HeaderPill({ view, open }: { view: PhoneView; open: () => void }) {
  return (
    <Boundary resetKey={view.view} fallback={<HeaderFallback open={open} />}>
      <HeaderPillBody view={view} open={open} />
    </Boundary>
  );
}

/** What stands in for the pill when it cannot be drawn: the way to Where MoMo runs stays. */
function HeaderFallback({ open }: { open: () => void }) {
  const theme = useTheme();
  return (
    <Tap accessibilityRole="button" accessibilityLabel={say('momo', { name: '' })} onPress={open}>
      <View style={{ minHeight: 44, justifyContent: 'center', paddingHorizontal: 14, borderRadius: 22, backgroundColor: theme.sunken }}>
        <Text style={{ ...typo.calloutMedium, color: theme.ink }}>{say('momo', { name: '' })}</Text>
      </View>
    </Tap>
  );
}

function HeaderPillBody({ view, open }: { view: PhoneView; open: () => void }) {
  const theme = useTheme();
  const pill = headerPill(view);
  // at a large text size the machine name wraps to a second line instead of being lost behind an ellipsis
  const { fontScale } = useWindowDimensions();
  return (
    <Tap accessibilityRole="button" accessibilityLabel={`${pill.label}. ${pill.hint}`} onPress={open} style={{ flexShrink: 1 }}>
      <View
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          gap: 8,
          minHeight: 44,
          paddingHorizontal: 14,
          borderRadius: 22,
          backgroundColor: pill.dot === 'amber' ? theme.warnSoft : theme.sunken,
        }}
      >
        <StateDot dot={pill.dot} />
        {/* a long machine name is cut with an ellipsis; the dot stays and so does the start of the label */}
        <Text
          numberOfLines={fontScale > 1.3 ? 2 : 1}
          ellipsizeMode="tail"
          style={{ ...typo.calloutMedium, color: theme.ink, flexShrink: 1 }}
        >
          {/* wrapped, the two halves sit on two lines and the separator goes: it never dangles at the end of the first */}
          {fontScale > 1.3 ? pill.label.replace(' · ', '\n') : pill.label}
        </Text>
      </View>
    </Tap>
  );
}

/** The banner when the home sleeps, is out of date or signed out; nothing when it works. */
export function HomeBanner({ view, act }: { view: PhoneView; act: Act }) {
  return (
    <Boundary resetKey={view.view} fallback={null}>
      <HomeBannerBody view={view} act={act} />
    </Boundary>
  );
}

function HomeBannerBody({ view, act }: { view: PhoneView; act: Act }) {
  const banner = homeBanner(view);
  if (!banner) return null;
  return (
    <Card tone="warn">
      <Title>{banner.title}</Title>
      {!!banner.body && <Body>{banner.body}</Body>}
      <Actions actions={banner.actions} act={act} />
    </Card>
  );
}

/** Delivery problems (notifications off, brief missed): the exact sentence with its one-tap fix. */
export function ProblemBanners({ view, act }: { view: PhoneView; act: Act }) {
  return (
    <>
      {view.view.problems.map((p, i) => (
        <Boundary key={`p:${p.id}`} resetKey={p} fallback={null}>
          <DeliveryProblem view={view} index={i} act={act} />
        </Boundary>
      ))}
      {view.view.home.sources.map((s) => (
        <Boundary key={`s:${s.id}`} resetKey={s} fallback={null}>
          <SourceProblem view={view} id={s.id} act={act} />
        </Boundary>
      ))}
    </>
  );
}

function DeliveryProblem({ view, index, act }: { view: PhoneView; index: number; act: Act }) {
  const p = deliveryProblems(view)[index];
  return (
    <Card tone="warn">
      <Body dim={false}>{p.cause}</Body>
      <Actions actions={[p.action, ...p.also]} act={act} />
    </Card>
  );
}

function SourceProblem({ view, id, act }: { view: PhoneView; id: string; act: Act }) {
  const p = sourceProblems(view).find((x) => x.id === id);
  if (!p) return null;
  return (
    <Card tone="warn">
      <Title>{p.title}</Title>
      {!!p.body && <Body>{p.body}</Body>}
      {p.action && <Actions actions={[p.action]} act={act} />}
    </Card>
  );
}

/** The floating tab pill. */
export function TabPill({ tab, set, bottom = 28 }: { tab: Tab; set: (tab: Tab) => void; bottom?: number }) {
  const theme = useTheme();
  return (
    <>
      {/* what scrolls under the bar is covered, not seen through the gaps around it */}
      <View
        pointerEvents="none"
        style={{ position: 'absolute', left: 0, right: 0, bottom: 0, height: bottom + 60, backgroundColor: theme.bg }}
      />
      <View
        style={{
          position: 'absolute',
          bottom,
          alignSelf: 'center',
          flexDirection: 'row',
          padding: 4,
          borderRadius: 26,
          backgroundColor: theme.surface,
        }}
      >
        {TABS.map((t) => (
          <Tap
            key={t.key}
            // a button with its own name and its selected state: the system lists it with the other controls (a `tab` role inside a floating bar was not listed)
            accessibilityRole="button"
            accessibilityLabel={say(t.label)}
            accessibilityState={{ selected: tab === t.key }}
            onPress={() => set(t.key)}
            style={{
              minHeight: 44,
              minWidth: 84,
              borderRadius: 22,
              alignItems: 'center',
              justifyContent: 'center',
              backgroundColor: tab === t.key ? theme.segment : 'transparent',
            }}
          >
            {/* the tab labels stay one line and apart at the largest text size */}
            <Text
              numberOfLines={1}
              maxFontSizeMultiplier={1.2}
              style={{ ...typo.calloutMedium, color: tab === t.key ? theme.ink : theme.ink2, paddingHorizontal: 6 }}
            >
              {say(t.label)}
            </Text>
          </Tap>
        ))}
      </View>
    </>
  );
}
