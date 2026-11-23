// One native text view of runs (#4837, #5359): drawn unseen until it has measured its text, swapped for the React drawing of the same words in one commit, with a link in it opened as everywhere else and the app's own menu entries handed to the caller.
import { type ComponentRef, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { Dimensions, View } from 'react-native';
import { ChatLinkContext } from '../chatLinks';
import { linkOpener, showLinkMenu } from './linkMenu';
import { nativeSelectableText, type SelectableTextProps } from '../platform/selectableText';
import { isNear, KEEP_SCREENS, nativeGate } from '../presentation/nativeGate';
import type { ProseRun } from '../presentation/proseRuns';
import { useTranslation } from '../ui/i18n';

const HIDDEN = { position: 'absolute', top: 0, left: 0, right: 0, opacity: 0 } as const;
/** A native view whose text is this much (points) taller or shorter than the React text it replaces takes the React text's height: nothing around the run moves when it becomes native (a pixel of rounding, a line-metric hair). More than this is a real difference and the view's own height. */
export const PARITY_SLACK = 4;

/**
 * `fallback` is the same words drawn by React Native: it stays on screen while the native view lays its text out unseen beside it, and the two swap
 * in one commit once the view has said how tall it is, so the text never shows at a line's height or jumps (the swap at the end of a stream, #4837).
 */
export function NativeRun({
  runs,
  entries,
  onEntry,
  fallback,
}: {
  runs: ProseRun[];
  entries: NonNullable<SelectableTextProps['menuEntries']>;
  /** an entry of the menu was chosen: its id, and the selected words for one marked `selection` */
  onEntry: (id: string, text: string) => void;
  fallback: ReactNode;
}) {
  const Native = nativeSelectableText();
  const { t } = useTranslation();
  const openChat = useContext(ChatLinkContext);
  // until the view reports the height its text needs it is drawn unseen (and unheard), out of the layout
  const [height, setHeight] = useState<number | null>(null);
  // The native view is mounted only once the chat is still and this run is near the screen, or the moment it is touched (#5369): until then
  // the run is its React text, the same words at the same height. It goes back to React text when the screen has moved well away from it.
  const [wanted, setWanted] = useState(() => !nativeGate.lazy());
  const box = useRef<ComponentRef<typeof View>>(null);
  const alive = useRef(true);
  // the React text's height while it is what is drawn, and the last height the native view reported: the first swap keeps the first (see PARITY_SLACK)
  const reactHeight = useRef<number | null>(null);
  const reported = useRef<number | null>(null);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  useEffect(() => {
    if (!nativeGate.lazy()) return;
    // the screen is still: where is this run? (asked each time the view comes to rest)
    const consider = () => {
      const view = box.current;
      if (!view?.measureInWindow) return;
      // where the run stands relative to the window: from its place in the list's content and where the list's window is (`measureInWindow` alone put every run about a screen lower than it was after the list went to its end, so the runs under the reader's finger were far away and stayed React text, #5369)
      const decide = (y: number, h: number, screen: number) => {
        // the run may have gone (its row was dropped) before the window answered
        if (!alive.current) return;
        if (!wanted) {
          if (isNear(y, h, screen)) setWanted(true);
        } else if (!isNear(y, h, screen, KEEP_SCREENS)) {
          setWanted(false);
          setHeight(null);
          reactHeight.current = null;
          reported.current = null;
        }
      };
      const inWindow = () => view.measureInWindow((_x, y, _w, h) => decide(y, h, Dimensions.get('window').height));
      const port = nativeGate.viewport();
      const content = nativeGate.content();
      if (port && content && view.measureLayout) {
        view.measureLayout(
          content as Parameters<typeof view.measureLayout>[0],
          (_x, y, _w, h) => decide(y - port.top, h, port.height),
          inWindow,
        );
      } else inWindow();
    };
    if (nativeGate.idle()) consider();
    return nativeGate.onIdle(consider);
  }, [wanted]);
  if (!Native) return null;
  // a block with no styled run at all, or runs with no words in them (an empty list item, heading, link or table cell, an image with no description) has nothing for the view to lay out, and no leading to size it by: it is the React text. Nothing below indexes `runs` without this.
  if (runs.every((run) => run.t === '')) return <>{fallback}</>;
  const ready = wanted && height !== null;
  return (
    // a finger on the React text asks for the native view at once, unless it is a scroll (a drag over runs would mount each of them): the next press selects
    <View
      ref={box}
      onLayout={(e) => {
        if (height === null) reactHeight.current = e.nativeEvent.layout.height;
      }}
      onTouchStartCapture={() => {
        // a shown native view answers this touch's long press itself; on React text the app's sheet does (see MessageBubble), since a view mounted now cannot take this touch
        nativeGate.touch(ready);
        if (nativeGate.idle()) setWanted(true);
      }}
    >
      {!ready && fallback}
      {wanted && (
        <View
          style={ready ? undefined : HIDDEN}
          pointerEvents={ready ? 'auto' : 'none'}
          accessibilityElementsHidden={!ready}
          importantForAccessibility={ready ? 'auto' : 'no-hide-descendants'}
        >
          <Native
            runs={runs}
            serif
            menuEntries={entries}
            style={{ height: height ?? Number(runs[0].lh) }}
            onContentSize={(e) => {
              // a view that has not laid its text out yet reports less than a line: that is not its height, and a row that swaps in at it shrinks the list and grows it again
              const own = e.nativeEvent.height;
              if (own < Number(runs[0].lh) || own === reported.current) return;
              reported.current = own;
              const react = reactHeight.current;
              setHeight(react !== null && Math.abs(own - react) <= PARITY_SLACK ? react : own);
            }}
            onLinkPress={(e) => {
              const { url, menu } = e.nativeEvent;
              const open = linkOpener(url, openChat);
              // a long press offers Open and Copy link, as a link in a reply still streaming does
              if (menu) showLinkMenu(url, { open: t('message.openLink'), copy: t('message.copyLink'), cancel: t('message.cancel') }, open);
              else open?.();
            }}
            onMenuAction={(e) => onEntry(e.nativeEvent.id, e.nativeEvent.text ?? '')}
            onMenuShown={nativeGate.answer}
            onSelect={nativeGate.answer}
          />
        </View>
      )}
    </View>
  );
}
