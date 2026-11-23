// A split view pane's header, as Claude Desktop's: the chat's title, a menu to move the pane or close it, and Close
// split view (the pane goes; its chat keeps running).

import { MoreHorizontal, X } from '../ui/icons';
import { applySplitOp, moveSplitPane } from '../../store/splitView';
import { threadTitle, useStore } from '../../store/core';
import { native } from '../../lib/native';
import { noteIgnored } from '../../lib/ignored';
import { Tooltip } from '../ui/Popover';
import { PANE_DRAG } from '../../lib/splitDrop';
import { setDraggedPane } from './useSplitDrop';
import { MorphText } from '../ui/MorphText';

/** The labels the pane menu and its buttons use (and the agent tools' replies, PR S4). */
export const SPLIT_PANE_LABELS = {
  close: 'Close split view',
  left: 'Move split view left',
  right: 'Move split view right',
  options: 'Split view options',
} as const;

export function SplitPaneHead({ chatId, index, count }: { chatId: string; index: number; count: number }) {
  const title = useStore((s) => threadTitle(s.threads[chatId]));
  const close = () => applySplitOp({ op: 'close', chatId });
  const menu = async () => {
    const picked = await native.menu
      .popup([
        ...(index > 0 ? [{ id: 'left', label: SPLIT_PANE_LABELS.left }] : []),
        ...(index < count - 1 ? [{ id: 'right', label: SPLIT_PANE_LABELS.right }] : []),
        ...(count > 1 ? [{ type: 'separator' as const }] : []),
        { id: 'close', label: SPLIT_PANE_LABELS.close },
      ])
      .catch((error) => (noteIgnored('show the split view pane menu', error), null));
    if (picked === 'left' || picked === 'right') moveSplitPane(chatId, picked === 'left' ? -1 : 1);
    else if (picked === 'close') close();
  };
  return (
    // drag the header onto another pane: Move here at its edge, Swap in its middle (src/lib/splitDrop.ts)
    <header
      className="split-pane-head"
      draggable
      onDragStart={(e) => {
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData(PANE_DRAG, chatId);
        setDraggedPane(chatId);
      }}
      onDragEnd={() => setDraggedPane(null)}
    >
      <span className="split-pane-title" title={title}>
        <MorphText key={chatId} morphKey={title} className="morph-fit">
          {title}
        </MorphText>
      </span>
      <Tooltip label={SPLIT_PANE_LABELS.options}>
        <button type="button" className="icon-btn xs" aria-label={SPLIT_PANE_LABELS.options} onClick={menu}>
          <MoreHorizontal size={14} />
        </button>
      </Tooltip>
      <Tooltip label={SPLIT_PANE_LABELS.close}>
        <button type="button" className="icon-btn xs" aria-label={SPLIT_PANE_LABELS.close} onClick={close}>
          <X size={14} />
        </button>
      </Tooltip>
    </header>
  );
}
