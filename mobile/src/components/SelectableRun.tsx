// A stretch of a reply's prose (paragraphs, headings, lists) as one native text view: iOS selects a range of it in place, across paragraphs, with handles and its edit menu, and a link in it opens as everywhere else (#4837).
import { useContext, useMemo, type ReactNode } from 'react';
import { useWindowDimensions } from 'react-native';
import { ReplyContext } from '../replyContext';
import { SideChatContext } from '../sideChat';
import { NativeRun } from './NativeRun';
import { proseRuns } from '../presentation/proseRuns';
import { useTheme } from '../theme';
import { useTranslation } from '../ui/i18n';

type Block = Parameters<typeof proseRuns>[0][number];

/**
 * `fallback` is the same blocks drawn by React Native: it stays on screen while the native view lays its text out unseen beside it, and the two swap
 * in one commit once the view has said how tall it is, so the reply never shows at a line's height or jumps (the swap at the end of a stream, #4837).
 */
export function SelectableRun({
  blocks,
  copyMessage,
  selectText,
  fallback,
}: {
  blocks: Block[];
  copyMessage?: () => void;
  selectText?: () => void;
  fallback: ReactNode;
}) {
  const theme = useTheme();
  const { t } = useTranslation();
  // the chat's composer takes a quote of the selected words; a chat without one offers no Ask
  const reply = useContext(ReplyContext);
  // Start a side chat from the selection: offered, or greyed with the reason it cannot be; no entry where it is not known yet
  const side = useContext(SideChatContext);
  // the system text scale, which React Native applies to a size and its line height together (and which changes with the setting)
  const { fontScale: scale } = useWindowDimensions();
  const runs = useMemo(
    () => proseRuns(blocks, { ink: theme.ink, link: theme.info, codeBg: theme.sunken, mark: theme.ink2 }, scale),
    [blocks, theme, scale],
  );
  const entries = [
    ...(reply ? [{ id: 'ask', title: t('message.ask'), first: '1' as const, selection: '1' as const }] : []),
    ...(side
      ? [
          {
            id: 'sideChat',
            title: t('message.sideChat'),
            selection: '1' as const,
            ...('why' in side && { off: '1' as const, why: side.why }),
          },
        ]
      : []),
    { id: 'copyMessage', title: t('message.copyMessage') },
    // the reply's React text carried Select Text for VoiceOver; the native text keeps it as an action of its own, off the menu
    { id: 'selectText', title: t('message.selectText'), vo: '1' as const },
  ];
  const onEntry = (id: string, text: string) => {
    if (id === 'ask') reply?.(text);
    else if (id === 'sideChat') side && 'start' in side && side.start(text);
    else if (id === 'selectText') selectText?.();
    else copyMessage?.();
  };
  return <NativeRun runs={runs} entries={entries} onEntry={onEntry} fallback={fallback} />;
}
