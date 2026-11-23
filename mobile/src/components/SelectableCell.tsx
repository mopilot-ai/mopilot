// A table cell as a native text view (#5359): a long press selects a word in it in place, and the menu reads Ask · Copy · Select Cell, with Select Table after the system's entries, as ChatGPT's does.
import { useContext, useMemo, type ReactNode } from 'react';
import { useWindowDimensions } from 'react-native';
import { ReplyContext } from '../replyContext';
import { NativeRun } from './NativeRun';
import { cellRuns } from '../presentation/proseRuns';
import { useTheme } from '../theme';
import { useTranslation } from '../ui/i18n';

type Cell = Parameters<typeof cellRuns>[0];

/** `fallback` is the cell as React draws it, held until the native view has measured its words (see NativeRun). `selectTable` opens the table's menu (Ask, Copy table...). */
export function SelectableCell({
  cell,
  header,
  align,
  selectTable,
  fallback,
}: {
  cell: Cell;
  header: boolean;
  align: 'left' | 'right' | 'center' | null | undefined;
  selectTable: () => void;
  fallback: ReactNode;
}) {
  const theme = useTheme();
  const { t } = useTranslation();
  const reply = useContext(ReplyContext);
  const { fontScale: scale } = useWindowDimensions();
  const runs = useMemo(
    () => cellRuns(cell, header, align, { ink: theme.ink, link: theme.info, codeBg: theme.sunken }, scale),
    [cell, header, align, theme, scale],
  );
  const entries = [
    ...(reply ? [{ id: 'ask', title: t('message.ask'), first: '1' as const, selection: '1' as const }] : []),
    { id: 'selectCell', title: t('message.selectCell'), near: '1' as const, native: 'selectAll' as const },
    { id: 'selectTable', title: t('message.selectTable') },
  ];
  const onEntry = (id: string, text: string) => {
    if (id === 'ask') reply?.(text);
    else if (id === 'selectTable') selectTable();
  };
  return <NativeRun runs={runs} entries={entries} onEntry={onEntry} fallback={fallback} />;
}
