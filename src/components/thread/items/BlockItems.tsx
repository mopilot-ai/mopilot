// Standalone replies, plans, images and status/task blocks in a turn.
import { TaskProposalCard } from '../TaskProposalCard';
import { ScheduledTaskCard } from '../ScheduledTaskCard';
import { ArtifactCard } from '../ArtifactCard';
import { memo, useEffect, useState } from 'react';
import type { StatusNoteItem, TaskEvent } from '../../../store/types';
import { TaskEventCard } from '../../tasks/TaskEventCard';
import { noteEvents } from '../../../lib/taskEvents';
import { Markdown } from '../../markdown/Markdown';
import { useSmoothText } from '../arrival';
import { PlanCard } from '../PlanCard';
import { LimitNoteAction } from '../LimitNoteAction';
import { ReviewCard, type ReviewCardSource } from '../ReviewCard';
import { ZoomableImage } from '../../ui/ImageLightbox';
import { basename } from '../../../lib/paths';
import { native } from '../../../lib/native';
import { ignoring } from '../../../lib/ignored';
import { compactionLabel } from '../../../harness/codexTranslate';
import {
  ImageIcon,
  Webhook,
  Activity,
  AlarmClock,
  Minimize2,
  FileSearch,
  BellRing,
  Target,
  UserRoundCog,
  MessagesSquare,
  Repeat,
  Gauge,
  ArrowLeftRight,
  Ban,
} from '../../ui/icons';
import { Shimmer } from './presentation';
import { toolCard, type DisplayItem, type ItemOf } from './stepModel';
import { AnsweredQuestions } from '../AnsweredQuestions';
import { NudgeCard } from '../../momo/NudgeCard';
import { MomoDraftCard } from '../../momo/MomoDraftCard';
import { BriefLine } from '../../momo/BriefLine';
/** Where a chat changed harness: who handed over to whom, with the handoff record one click away. */
function SwitchDivider({ item }: { item: StatusNoteItem }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="switch-divider">
      <div className="switch-divider-row">
        <ArrowLeftRight size={13} strokeWidth={1.8} />
        <span>{item.text}</span>
        {item.handoff && (
          <button className="switch-divider-toggle" onClick={() => setOpen((o) => !o)}>
            {open ? 'Hide handoff' : 'View handoff'}
          </button>
        )}
      </div>
      {open && <pre className="switch-handoff">{item.handoff}</pre>}
    </div>
  );
}

/**
 * A context compaction: a divider, never a message (shared/compaction.mjs). The summary the harness wrote, when it gave
 * one, is one click away, as Claude Code keeps it in its transcript view rather than in the chat.
 */
function CompactionDivider({ item, cwd }: { item: ItemOf<'contextCompaction'> & { summary?: unknown }; cwd: string }) {
  const [open, setOpen] = useState(false);
  const summary = typeof item.summary === 'string' ? item.summary : '';
  return (
    <div className="compaction-divider">
      <div className="divider-label">
        <Minimize2 size={12} /> {compactionLabel(item)}
        {summary && (
          <button type="button" className="compaction-toggle" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
            {open ? 'Hide summary' : 'View summary'}
          </button>
        )}
      </div>
      {open && (
        <div className="compaction-summary">
          <Markdown text={summary} cwd={cwd} />
        </div>
      )}
    </div>
  );
}

/** A reply's text; one that arrives while the chat is open streams in step by step, its words fading in. */
export function ReplyText({
  item,
  cwd,
  running,
  streaming = running,
}: {
  item: { id: string; text?: string | null };
  cwd: string;
  running: boolean;
  streaming?: boolean;
}) {
  const paced = useSmoothText(item.id, item.text ?? '', running, streaming);
  return (
    <div data-selection-source={item.id}>
      <Markdown
        text={paced.text}
        cwd={cwd}
        animate={paced.animate}
        streaming={paced.streaming}
        steps={paced.steps}
        stepTimes={paced.stepTimes}
      />
    </div>
  );
}

/** Memoized: a settled item keeps its object, so a delta to the running turn leaves the blocks before it alone. */
export const BlockItem = memo(function BlockItem({
  item,
  cwd,
  running = false,
  streaming = running,
  threadId,
  turnId,
  readOnly = false,
  arrive = false,
}: {
  item: DisplayItem;
  cwd: string;
  running?: boolean;
  streaming?: boolean;
  /** the chat a task event card opens the Background tasks tab of */
  threadId?: string;
  turnId?: string;
  readOnly?: boolean;
  /** a note that arrives whole (MoMo's shell chat) rises into place as it appears */
  arrive?: boolean;
}) {
  // the same answer buildBlocks routed by (isBlockItem), so every card it keeps out of the steps is drawn here
  const card = toolCard(item);
  if (card?.kind === 'scheduled') return <ScheduledTaskCard call={card.call} />;
  if (card?.kind === 'session') return <TaskProposalCard call={card.call} threadId={threadId} readOnly={readOnly} />;
  if (card?.kind === 'artifact') return <ArtifactCard artifact={card.artifact} />;
  switch (item.type) {
    case 'agentMessage':
      return item.text?.trim() ? (
        <div className="commentary" data-arrive={arrive ? '' : undefined}>
          <ReplyText item={item} cwd={cwd} running={running} streaming={streaming} />
        </div>
      ) : null;
    case 'plan':
      return <PlanCard item={item} cwd={cwd} threadId={threadId} turnId={turnId} streaming={streaming} />;
    case 'imageView':
      return <ImageViewItem path={item.path} />;
    case 'imageGeneration':
      return <ImageGenItem item={item} />;
    case 'contextCompaction':
      return <CompactionDivider item={item} cwd={cwd} />;
    case 'enteredReviewMode':
      return (
        <div className="step-row">
          <span className="step-icon">
            <FileSearch size={16} strokeWidth={1.6} />
          </span>
          <span className="step-text">Reviewing {item.review}</span>
        </div>
      );
    case 'exitedReviewMode':
      return <ReviewCard item={item as ReviewCardSource} cwd={cwd} chatId={threadId} />;
    case 'hookPrompt':
      return (
        <div className="step-row">
          <span className="step-icon">
            <Webhook size={16} strokeWidth={1.6} />
          </span>
          <span className="step-text hook-feedback">{item.fragments?.map((f) => f.text).join(' ')}</span>
        </div>
      );
    case 'statusNote':
      // switch divider (expandable handoff), model change, quota hint, a MoMo nudge, computer use refusing an app, or Claude Code status injected as a user turn
      if (item.kind === 'switch') return <SwitchDivider item={item} />;
      if (item.kind === 'answers' && item.answers?.length) return <AnsweredQuestions answers={item.answers} />;
      if (item.kind === 'nudge' && item.nudge) return <NudgeCard text={item.text} nudge={item.nudge} />;
      // a draft MoMo wrote for the user: its own card, with Edit, Copy, Open in Mail and Send
      // a line of MoMo's morning brief, or its suggestion card
      if (item.kind === 'brief') return <BriefLine text={item.text} suggestion={item.suggestion} />;
      if (item.kind === 'draft' && item.draft) return <MomoDraftCard draft={item.draft} chatId={threadId} noteId={item.id} />;
      if (item.kind === 'task' && item.task)
        return <TaskEventCard events={noteEvents(item as typeof item & { task: TaskEvent })} chatId={threadId} />;
      return (
        <div className={`step-row status-note ${item.kind ?? ''}`}>
          <span className="step-icon">
            {item.kind === 'peer' ? (
              <MessagesSquare size={16} strokeWidth={1.6} />
            ) : item.kind === 'model' ? (
              <Repeat size={16} strokeWidth={1.6} />
            ) : item.kind === 'limit' ? (
              <Gauge size={16} strokeWidth={1.6} />
            ) : item.kind === 'account' ? (
              <UserRoundCog size={16} strokeWidth={1.6} />
            ) : item.kind === 'goal' ? (
              <Target size={16} strokeWidth={1.6} />
            ) : item.kind === 'control' ? (
              <Ban size={16} strokeWidth={1.6} />
            ) : item.kind === 'wake' ? (
              item.wake?.by === 'checkin' ? (
                <AlarmClock size={16} strokeWidth={1.6} />
              ) : (
                <Activity size={16} strokeWidth={1.6} />
              )
            ) : (
              <BellRing size={16} strokeWidth={1.6} />
            )}
          </span>
          <span className="step-text">
            {item.text}
            {/* what the wake reported ("unit (1): success"), marked when it says something went wrong */}
            {item.wake?.detail ? <span className={item.wake.failed ? 'step-exit' : 'step-em'}>: {item.wake.detail}</span> : null}
          </span>
          {item.kind === 'limit' && threadId && <LimitNoteAction chatId={threadId} />}
        </div>
      );
    default:
      return null;
  }
});

function ImageViewItem({ path }: { path: string }) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    // unreadable: the step shows without its picture
    native.fs.readImageDataUrl(path).then(setUrl, ignoring("read an image step's picture"));
  }, [path]);
  return (
    <div className="image-step">
      <div className="step-row">
        <span className="step-icon">
          <ImageIcon size={16} strokeWidth={1.6} />
        </span>
        <span className="step-text">Viewed {basename(path)}</span>
      </div>
      {url && <ZoomableImage className="inline-image" src={url} />}
    </div>
  );
}

function ImageGenItem({ item }: { item: ItemOf<'imageGeneration'> }) {
  const src =
    item.result?.startsWith('data:') || item.result?.startsWith('http')
      ? item.result
      : item.result
        ? `data:image/png;base64,${item.result}`
        : null;
  if (item.failure) return <div className="step-row">Image generation failed</div>;
  if (!src)
    return (
      <div className="step-row active">
        <Shimmer>Generating image</Shimmer>
      </div>
    );
  return (
    <div className="gen-image">
      <ZoomableImage src={src} />
      {item.revisedPrompt && <div className="gen-image-caption">{item.revisedPrompt}</div>}
    </div>
  );
}
