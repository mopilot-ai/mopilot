// One work step row, its links and background command state, with expandable details.
import { useLinkCwd } from '../../../lib/remoteFolder';
import { absPath, fileName } from '../../../lib/paths';
import { isWin } from '../../../lib/platform';
import { openMessageLink } from '../../../session/open';
import { Collapse } from '../../ui/Presence';
import { useContext, useId, useState, type ReactNode } from 'react';
import { Markdown } from '../../markdown/Markdown';

import { useSession } from '../../../store/session/useSession';
import { isRunningTask } from '../../../lib/tasks';
import { mergeTasks, useAdapterTasks } from '../../../store/backgroundTasks';
import { fileChangeToDiff, InlineDiff } from '../../diff/DiffView';
import { prettyCommand, formatDuration } from '../../../lib/format';
import { relPath } from '../../../lib/paths';
import { toggleTasksPane } from '../../../store/panes';
import { reasoningText } from '../../../lib/reasoning';
import { controlImages, controlThumbnail, skyProblemText } from '../../../lib/agentNarration';
import { ZoomableImage } from '../../ui/ImageLightbox';
import { Activity, AlarmClock, ChevronDown, ChevronRight, GitFork, MousePointerClick, Palette } from '../../ui/icons';
import { sageCallLine } from '../../../lib/windowToolCall';
import { ownToolLine, shownToolName } from '../../../lib/ownToolLines';
import { designCallLine } from '../../../lib/designToolCall';
import { skillCall, skillCallVerb } from '../../../session/skillToolCall';
import { SkillGlyph } from '../../markdown/SkillGlyph';
import { openSkillClick } from '../../../session/openSkill';
import { useSkillPath } from '../../../session/harness/skillPath';
import { ActivityChat } from '../turnTokens';
import { Shimmer, firstLine, hostOf, agentVerb, stepIcon } from './presentation';
import { stepControl, thoughtItems, type Step, type WithStatus } from './stepModel';
import { ShellBox, SkillCallBody, SkyProblemNote, ToolIO } from './output';
import { AgentChatContext } from '../../agents/AgentChatContext';
import { cutOffByStop, thoughtLabel, useTurnTiming } from './turnTiming';
import { settledText } from '../../../lib/streamCut';
import { StepThumbs } from './StepSummary';

/** A file a step names: opens it beside the conversation (Cmd-click: in its own app). */
function FileLink({ path, cwd }: { path: string; cwd: string }) {
  const linkCwd = useLinkCwd(cwd);
  const abs = absPath(path, cwd);
  return (
    <button type="button" className="step-file-link" onClick={(e) => openMessageLink(abs, linkCwd, e)} title={abs}>
      {fileName(relPath(path, cwd), isWin)}
    </button>
  );
}

/** A page a step opened: a real link, shown in the in-app browser (Cmd-click: the system browser). */
function PageLink({ url, cwd }: { url: string; cwd: string }) {
  return (
    <a
      className="step-file-link"
      href={url}
      onClick={(e) => {
        e.preventDefault();
        openMessageLink(url, cwd, e);
      }}
    >
      {hostOf(url)}
    </a>
  );
}

/** "Ran" for a finished command; a command sent to the background keeps "Running" (shimmering) until its task settles. */
function CommandVerb({ item }: { item: { id: string; background?: boolean } }) {
  return item.background ? <BackgroundCommandVerb id={item.id} /> : <>Ran </>;
}

/** The chat being rendered and its tasks: Claude's live in the session; Codex's are read by the app and kept beside it. */
function useChatTaskList() {
  const chatId = useContext(AgentChatContext);
  return { chatId, tasks: mergeTasks(useSession(chatId).tasks, useAdapterTasks(chatId)) };
}

/** The task a background command's tool call started, in the chat being rendered. */
function useBackgroundTask(id: string) {
  const { chatId, tasks } = useChatTaskList();
  const task = tasks.find((t) => t.toolUseId === id);
  return { chatId, running: !!task && isRunningTask(task), failed: task?.status === 'failed' };
}

function BackgroundCommandVerb({ id }: { id: string }) {
  const { running } = useBackgroundTask(id);
  return running ? (
    <>
      <Shimmer>Running</Shimmer>{' '}
    </>
  ) : (
    <>Ran </>
  );
}

/** "View live output ›" beside a command that still runs in the background, as Claude shows it: it opens the Background tasks tab. */
function LiveLinkButton({ chatId }: { chatId: string }) {
  return (
    <button type="button" className="step-live-link" onClick={() => toggleTasksPane(chatId)}>
      View live output
      <ChevronRight size={12} aria-hidden />
    </button>
  );
}

/** A background command's task, on its row: the live link while it runs, " · failed" when it ended badly and the row's exit says nothing yet. */
function BackgroundState({ id, exitShown }: { id: string; exitShown: boolean }) {
  const { chatId, running, failed } = useBackgroundTask(id);
  if (running && chatId) return <LiveLinkButton chatId={chatId} />;
  return failed && !exitShown ? <span className="step-exit"> · failed</span> : null;
}

/** The live link on a collapsed group's summary while a background command inside it runs, so a folded row still offers it. */
export function GroupLiveLink({ items }: { items: { id: string; type: string; background?: boolean }[] }) {
  const ids = items.filter((i) => i.type === 'commandExecution' && i.background).map((i) => i.id);
  // only a group that sent a command to the background reads the chat's tasks
  return ids.length ? <GroupLiveLinkFor ids={ids} /> : null;
}

function GroupLiveLinkFor({ ids }: { ids: string[] }) {
  const { chatId, tasks } = useChatTaskList();
  const live = tasks.some((t) => !!t.toolUseId && ids.includes(t.toolUseId) && isRunningTask(t));
  return live && chatId ? <LiveLinkButton chatId={chatId} /> : null;
}

/** A skill call's "/name": it opens the skill pane when the chat's harness can say where its SKILL.md is, else it is plain text. */
function SkillName({ chat, name }: { chat: string | null; name: string }) {
  const path = useSkillPath(chat, name);
  return path ? (
    <button type="button" className="step-file-link step-em" title={path} onClick={(e) => openSkillClick(path, e)}>
      /{name}
    </button>
  ) : (
    <span className="step-em">/{name}</span>
  );
}

/**
 * `inApp`: the step sits in a run in that one desktop app (ControlRun), which already names it: the row reads plainly
 * ("Clicked", not "Clicked in Notes"), with no icon of its own (Claude Design option 2A).
 * `shots`: the row stands alone between two replies, so a control call shows its screenshots below it at full size, as
 * Claude Desktop hoists a lone call's images, instead of as thumbnails.
 */
export function StepRow({
  step,
  cwd,
  running = false,
  inApp = null,
  shots = false,
  disclosure,
}: {
  step: Step;
  cwd: string;
  running?: boolean;
  inApp?: string | null;
  shots?: boolean;
  /** whether it is open, held by its group so a row that moves between renderers keeps it */
  disclosure?: { open: boolean; toggle: () => void };
}) {
  const [ownOpen, setOwnOpen] = useState(false);
  const open = disclosure ? disclosure.open : ownOpen;
  const toggle = disclosure ? disclosure.toggle : () => setOwnOpen((o) => !o);
  const textId = useId();
  let label: ReactNode = null;
  let body: ReactNode = null;
  let expandable = false;
  let icon: ReactNode = null;
  let thumb: string | null = null;
  let images: string[] = [];
  const timing = useTurnTiming();
  const chat = useContext(ActivityChat);
  // a step Stop cut off reads "Interrupted", not as a failure
  const interrupted = cutOffByStop(timing, step.item as WithStatus & { cutOff?: boolean });
  // a skill also fails by its result's error (skillToolCall.ts), whatever its status says
  const skillState = step.kind === 'tool' ? skillCall(step.item)?.state : undefined;
  const failed =
    !interrupted &&
    ((step.item as WithStatus).status === 'failed' ||
      (step.item as WithStatus).status === 'declined' ||
      skillState === 'failed' ||
      skillState === 'declined');
  // a browser or desktop failure the turn got past reads calmly; its error stays in the details
  const recovered = step.kind === 'tool' && !!step.recovered;

  switch (step.kind) {
    case 'read':
      label = (
        <>
          Read <FileLink path={step.path} cwd={cwd} />
        </>
      );
      break;
    case 'search':
      label = (
        <>
          Searched for <span className="step-em">{step.query}</span>
          {step.path ? (
            <>
              {' '}
              in <FileLink path={step.path} cwd={cwd} />
            </>
          ) : null}
        </>
      );
      break;
    case 'list':
      label = (
        <>
          Listed files
          {step.path ? (
            <>
              {' '}
              in <FileLink path={step.path} cwd={cwd} />
            </>
          ) : null}
        </>
      );
      break;
    case 'command': {
      const cmd = prettyCommand(step.item.command);
      // a command Stop ended reads "Interrupted": its exit code (the kill's) says nothing more
      const badExit = !interrupted && step.item.exitCode != null && step.item.exitCode !== 0;
      const unknownExit = !interrupted && step.item.exitCode == null && step.item.status === 'failed';
      // a leading sleep reads as the wait it is: "Waited 50s, then ran gh api …"
      const lead = step.wait && !step.wait.loop && !(step.item as { background?: boolean }).background ? step.wait : null;
      label = (
        <>
          {step.item.status === 'declined' ? (
            'Declined '
          ) : lead ? (
            `Waited ${formatDuration(lead.ms)}, then ran `
          ) : (
            <CommandVerb item={step.item as { id: string; background?: boolean }} />
          )}
          {firstLine(lead ? lead.rest : cmd)}
          {badExit && <span className="step-exit"> · exit {step.item.exitCode}</span>}
          {unknownExit && <span className="step-exit"> · exit code unknown</span>}
          {/* how long it ran, as Codex's "Ran … in 2s" and this row's tool calls say it */}
          {step.item.durationMs ? <span className="step-exit"> · {formatDuration(step.item.durationMs)}</span> : null}
          {(step.item as { background?: boolean }).background && <BackgroundState id={step.item.id} exitShown={badExit || unknownExit} />}
        </>
      );
      expandable = true;
      body = <ShellBox cmd={cmd} output={step.item.aggregatedOutput} exitCode={step.item.exitCode} unknownExit={unknownExit} />;
      break;
    }
    case 'edit': {
      const d = fileChangeToDiff(step.change);
      const verb = d.isNew ? 'Created' : d.isDeleted ? 'Deleted' : 'Edited';
      label = (
        <>
          {step.item.status === 'declined' ? 'Declined edit to ' : `${verb} `}
          <FileLink path={step.change.path} cwd={cwd} />{' '}
          <span className="step-stat">
            +{d.added} -{d.removed}
          </span>
        </>
      );
      expandable = true;
      body = <InlineDiff file={d} cwd={cwd} />;
      break;
    }
    case 'web': {
      const a = step.item.action;
      if (a?.type === 'openPage' && a.url)
        label = (
          <>
            Opened <PageLink url={a.url} cwd={cwd} />
          </>
        );
      else if (a?.type === 'findInPage')
        label = (
          <>
            Searched page for <span className="step-em">{a.pattern}</span>
          </>
        );
      else
        label = (
          <>
            Searched the web
            {step.item.query ? (
              <>
                {' '}
                for <span className="step-em">{step.item.query}</span>
              </>
            ) : null}
          </>
        );
      break;
    }
    case 'tool': {
      const control = stepControl(step);
      images = control && shots ? controlImages(step.item) : [];
      thumb = control && !images.length ? controlThumbnail(step.item) : null;
      // a linked-session or window call reads as what it did ("Opened session in split view"), not as the tool it called
      // a claude.ai artifact or Claude Design call reads the same way ("Published Landing page")
      const design = control ? null : designCallLine(step.item);
      const session = control ? null : (sageCallLine(step.item) ?? design);
      // a skill reads as the skill it loaded ("Loaded skill /fix-bug"), as Claude Code's transcript shows it
      const skill = control || session ? null : skillCall(step.item);
      // MoPilot's other own tools (MoMo's memory, a message to a chat, …) read as what they did ("Searched memory")
      const own = control || session || skill ? null : ownToolLine(step.item);
      const plain = !!inApp && control?.surface === 'desktop';
      const done = plain && control.done.endsWith(` in ${inApp}`) ? control.done.slice(0, -` in ${inApp}`.length) : control?.done;
      label = control ? (
        <>
          {done}
          {recovered ? (
            <span className="step-stat"> · Retried another way</span>
          ) : (
            control.problem && <span className="step-exit sky-problem-line"> · {skyProblemText(control.problem)}</span>
          )}
        </>
      ) : session ? (
        session.text
      ) : skill ? (
        <>
          {skill.state === 'running' && !interrupted ? <Shimmer>{skillCallVerb(skill)}</Shimmer> : skillCallVerb(skill, interrupted)}{' '}
          <SkillName chat={chat} name={skill.name} />
        </>
      ) : own ? (
        own.text
      ) : (
        <>
          Called {shownToolName(step.item).replace(' · ', ' ')}
          {step.item.durationMs ? <span className="step-exit"> · {formatDuration(step.item.durationMs)}</span> : null}
        </>
      );
      // a plain row has no icon slot at all (false, not null: null falls back to the kind's icon)
      if (design) icon = <Palette size={16} strokeWidth={1.6} />;
      else if (session) icon = <GitFork size={16} strokeWidth={1.6} />;
      else if (skill) icon = <SkillGlyph size={16} />;
      else if (control?.surface === 'desktop') icon = plain ? false : <MousePointerClick size={16} strokeWidth={1.6} />;
      else if (control) icon = stepIcon('web');
      expandable = true;
      body = control?.problem ? (
        <>
          <SkyProblemNote problem={control.problem} />
          <ToolIO item={step.item} hoisted={images.length > 0} />
        </>
      ) : skill ? (
        <SkillCallBody call={skill} />
      ) : (
        <ToolIO item={step.item} hoisted={images.length > 0} />
      );
      break;
    }
    case 'reasoning': {
      const thoughts = thoughtItems(step);
      label = (
        <>
          {running
            ? 'Thinking'
            : thoughtLabel(
                timing,
                thoughts.map((t) => t.id),
              )}
        </>
      );
      expandable = true;
      body = (
        <div className="reasoning-text">
          <Markdown
            text={settledText(
              thoughts
                .map((t) => reasoningText(t).trim())
                .filter(Boolean)
                .join('\n\n'),
              running,
            )}
            cwd={cwd}
            // an open thought parses only its tail as it grows, not all of its text on every delta
            streaming={running}
          />
        </div>
      );
      break;
    }
    case 'wait':
      label = `Waited${step.ms == null ? '' : ` ${formatDuration(step.ms)}`}${step.on ? ` for ${step.on}` : ''}`;
      break;
    case 'watch':
      // a watch armed to wake the agent later: what it watches, or when it checks in
      label =
        step.what === 'monitor'
          ? `Started a monitor${step.label ? ` · ${step.label}` : ''}`
          : step.stop
            ? 'Stopped the check-ins'
            : `Scheduled a check-in${step.ms == null ? '' : ` in ${formatDuration(step.ms)}`}`;
      icon = step.what === 'monitor' ? <Activity size={16} strokeWidth={1.6} /> : <AlarmClock size={16} strokeWidth={1.6} />;
      expandable = true;
      body = <ToolIO item={step.item} />;
      break;
    case 'agent': {
      label = (
        <>
          {agentVerb(step.item)}
          {step.item.prompt ? <> · {step.item.prompt.slice(0, 120)}</> : null}
          {step.item.summary && step.item.status === 'inProgress' ? <span className="step-exit"> · {step.item.summary}</span> : null}
        </>
      );
      break;
    }
    default:
      return null;
  }

  return (
    <div className={`step ${open ? 'open' : ''} ${recovered ? 'recovered' : failed || stepControl(step)?.problem ? 'failed' : ''}`}>
      {/* the text can hold links (a file, a page), so the toggle is a button laid over the row, not around it */}
      <div className={`step-row ${expandable ? 'expandable' : ''}`}>
        {expandable && <button type="button" className="step-row-hit" aria-expanded={open} aria-labelledby={textId} onClick={toggle} />}
        {icon === false ? null : <span className="step-icon">{icon ?? stepIcon(step.kind, (step as { network?: boolean }).network)}</span>}
        <span className="step-text" id={textId}>
          {label}
          {interrupted && <span className="step-exit"> · Interrupted</span>}
        </span>
        {expandable && <ChevronDown size={14} className="step-chevron" />}
        <StepThumbs srcs={thumb ? [thumb] : []} />
      </div>
      {images.length > 0 && (
        <div className={`step-shots${images.length > 1 ? ' several' : ''}`}>
          {images.map((src, i) => (
            <ZoomableImage key={src} className="step-shot" src={src} alt={`Screenshot ${i + 1}`} />
          ))}
        </div>
      )}
      {body && (
        <Collapse open={open}>
          <div className="step-body">{body}</div>
        </Collapse>
      )}
    </div>
  );
}
