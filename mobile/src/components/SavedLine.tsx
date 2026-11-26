// The amber "Saved on this phone" line over the top of a chat's list, and the room the list keeps for it: its going never moves the rows (#5379 row A).
import { useState, type ReactNode } from 'react';
import { View } from 'react-native';
import { useTheme } from '../theme';
import { SavedOnPhone } from './Notice';

/**
 * While `on`, the line is drawn over the list's top edge, not above the list: taking it away then changes neither the list's frame nor its
 * rows (above the list, its going grew the list upward and moved a reader at the top by its height). `room` is the line's measured height
 * (it grows with the text size), the top padding the list keeps so that, scrolled to the top, no row is under the line; it stays after the
 * line goes (the blank is above the chat's oldest row) and is 0 again in another chat. The line comes first in the screen's order, so
 * VoiceOver reads it before the rows.
 */
export function useSavedLine(chatId: string, on: boolean): { line: ReactNode; room: number } {
  const theme = useTheme();
  // (`room`, not a style's height: the line's own measure, kept per chat)
  const [kept, setKept] = useState<{ chatId: string; room: number }>({ chatId, room: 0 });
  const room = kept.chatId === chatId ? kept.room : 0;
  const line = on ? (
    <View
      style={{
        position: 'absolute',
        top: 0,
        left: 0,
        right: 0,
        zIndex: 1,
        paddingHorizontal: 16,
        paddingBottom: 8,
        backgroundColor: theme.bg,
      }}
      onLayout={(event) => {
        const height = event.nativeEvent.layout.height;
        setKept((was) => (was.chatId === chatId && was.room === height ? was : { chatId, room: height }));
      }}
    >
      <SavedOnPhone />
    </View>
  ) : null;
  return { line, room };
}
