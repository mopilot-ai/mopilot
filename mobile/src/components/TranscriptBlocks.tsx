// A chat's transcript as blocks: what was there when it opened shows at once, rows that arrive after fade in; folded runs of steps, replies, your messages and lone steps with their state, detail and screenshot.
import type { Block, KeyedRow } from '../presentation/toolRuns';
import { MessageBubble, ToolRun } from './MessageBubble';
import { memo, useEffect, useMemo, useRef } from 'react';
import type { Owned } from '../remote/client';
import { readStepPicture } from '../remote/stepPicture';
import { reportSentTop } from '../sendOrigin';
import { RiseIn } from './RiseIn';
import { SentBubble } from './SentBubble';
import { Enter, SkipFirstEntrance } from './Motion';
import { StepPictureProvider } from './StepPicture';
import { MessageImageProvider } from './MessageImages';
import { readMessageImage } from '../remote/messageImage';

/**
 * Whether earlier messages joined above the blocks in this render: the block that was first is still there, further down. Every block's
 * place then changes by the height of what joined, and the list moves its offset by the same to hold the row being read; a block that
 * glided to its new place meanwhile would carry the reader's text away, and the page would not hold (#4734). Read at the render that
 * commits the new blocks, and false again at the next.
 */
export function usePagedAbove(keys: readonly string[]): boolean {
  const firstSeen = useRef<string | null>(null);
  const first = keys[0] ?? null;
  const before = firstSeen.current;
  useEffect(() => {
    firstSeen.current = first;
  }, [first]);
  return before !== null && first !== before && keys.includes(before);
}

type RunOf = Extract<Block, { type: 'run' }>;

type Fields = Record<string, unknown>;
/** Two values that say the same: equal, or lists of equal values. */
const sameValue = (a: unknown, b: unknown) =>
  Object.is(a, b) || (Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((value, i) => Object.is(value, b[i])));
/** Two rows with the same fields, whether or not they are the same object: the transcript is built again on every event, and a row that did not change must not be drawn again (#4986). */
const sameRow = (a: object, b: object) => {
  const x = a as Fields;
  const y = b as Fields;
  const keys = Object.keys(x);
  return keys.length === Object.keys(y).length && keys.every((key) => sameValue(x[key], y[key]));
};
/** Two blocks that show the same: a row's fields, or a run's key, summary, running flag and each step's fields. */
export const sameBlock = (a: Block, b: Block) =>
  a === b ||
  (a.type === 'run'
    ? b.type === 'run' &&
      a.key === b.key &&
      a.summary === b.summary &&
      a.running === b.running &&
      a.steps.length === b.steps.length &&
      a.steps.every((step, i) => sameRow(step, b.steps[i]))
    : b.type === 'row' && sameRow(a.row, b.row));

/** One row of the transcript. Memoized on what the row says and four flags, so a commit that changed other rows leaves it (and its entrance) alone, whether or not the row object is the one it had. */
export const RowBlock = memo(
  function RowBlock({
    row,
    fade,
    hold,
    still,
    reportsTop,
    streaming,
  }: {
    row: KeyedRow;
    fade: boolean;
    hold: boolean;
    still: boolean;
    reportsTop: boolean;
    streaming: boolean;
  }) {
    const yours = row.role === 'user' || row.role === 'liveUser';
    const bubble = (
      <MessageBubble
        id={row.key}
        role={row.role}
        text={row.text}
        kind={row.kind}
        state={row.state}
        detail={row.detail}
        thumbnail={row.thumbnail}
        surface={row.surface}
        callId={row.callId}
        pictures={row.pictures}
        images={row.images}
        messageId={row.messageId}
        streaming={streaming}
      />
    );
    return (
      // your own message is already on screen (the queued bubble) when the computer's copy of it lands: it takes its place without fading in again,
      // and unseen while the ghost still rises over it, as the queued bubble was (RiseIn: one bubble from the tap to the landing, #5760)
      <Enter
        fade={fade && row.role !== 'user' && row.role !== 'liveUser'}
        hold={hold}
        leave={!still}
        onLayout={reportsTop ? (event) => reportSentTop(event.nativeEvent.layout.y, true) : undefined}
      >
        {yours ? <RiseIn>{bubble}</RiseIn> : bubble}
      </Enter>
    );
  },
  (a, b) =>
    a.fade === b.fade &&
    a.hold === b.hold &&
    a.still === b.still &&
    a.reportsTop === b.reportsTop &&
    a.streaming === b.streaming &&
    sameRow(a.row, b.row),
);

/** A folded run of steps, memoized on its block (the same block object while its steps and running state are the same). */
export const RunBlock = memo(
  function RunBlock({ block, fade, hold, still }: { block: RunOf; fade: boolean; hold: boolean; still: boolean }) {
    return (
      <Enter fade={fade} hold={hold} leave={!still}>
        <ToolRun steps={block.steps} summary={block.summary} running={block.running} />
      </Enter>
    );
  },
  (a, b) => a.fade === b.fade && a.hold === b.hold && a.still === b.still && sameBlock(a.block, b.block),
);

/**
 * `streamingKey` names the reply still being written: the one that ends a working turn, else none. `phase`: the blocks are the rows the chat
 * last showed ('saved'), the Mac's rows in the commit that replaces them ('arriving'), or the live transcript. Rows of the first two do not
 * animate (they are not new to the reader: nothing fades in, glides or fades out under a view the system keeps in place), and saved rows
 * never report where your newest message is (they would pin the list to a row that is not the computer's).
 */
export function TranscriptBlocks({
  blocks,
  streamingKey,
  phase = 'live',
  request,
  chatId,
}: {
  blocks: Block[];
  streamingKey: string | null;
  phase?: 'saved' | 'arriving' | 'live';
  /** the way to the Mac the step pictures read their full capture through, for this chat */
  request: Owned;
  chatId: string;
}) {
  // stable while the chat and the Mac stay, so a streamed delta does not re-render every picture
  const loadPicture = useMemo(() => (callId: string) => readStepPicture(request, chatId, callId), [request, chatId]);
  const loadImage = useMemo(
    () => (itemId: string, index: number, side: number) => readMessageImage(request, chatId, itemId, index, side),
    [request, chatId],
  );
  // the computer's own row of your newest message: when it takes the place of the queued bubble it can sit elsewhere, and the pin follows it there
  const lastRecord = blocks.findLastIndex(
    (b) => b.type !== 'run' && !b.row.optimistic && (b.row.role === 'user' || b.row.role === 'liveUser'),
  );
  // while the queued bubble is still drawn, the newest record of yours is an older message: only the bubble says where the new one is
  const lastYours = blocks.some((b) => b.type !== 'run' && b.row.optimistic) ? -1 : lastRecord;
  // by the rows under the blocks: a run that took in steps of the page above changes its own key, and the row that was first is still there
  const still = phase !== 'live';
  const paged = usePagedAbove(blocks.flatMap((b) => (b.type === 'run' ? b.steps.map((step) => step.key) : [b.row.key])));
  return (
    <StepPictureProvider load={loadPicture}>
      <MessageImageProvider load={loadImage}>
        <SkipFirstEntrance>
          {blocks.map((block, index) =>
            block.type === 'run' ? (
              <RunBlock key={`run:${block.key}`} block={block} fade={!paged && !still} hold={paged || still} still={still} />
            ) : block.row.optimistic ? (
              <SentBubble key={block.row.key} id={block.row.key} text={block.row.text} pictures={block.row.pictures} />
            ) : (
              <RowBlock
                key={block.row.key}
                row={block.row}
                fade={!paged && !still}
                hold={paged || still}
                still={still}
                reportsTop={phase !== 'saved' && index === lastYours}
                streaming={block.row.key === streamingKey}
              />
            ),
          )}
        </SkipFirstEntrance>
      </MessageImageProvider>
    </StepPictureProvider>
  );
}
