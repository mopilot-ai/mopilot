// Message markdown rendering: streaming word fade-in, directive chips, local images, links, chat links, pull request chips, code blocks and copy.

import { absPath, assetUrl, decodeLinkPath, localLinkParts, isAbsolutePath, joinPath } from '../../lib/paths';
import { RemoteFolderContext, parseRemoteCwd, remoteCwd, remotePathOf } from '../../lib/remoteFolder';
import { openMessageLink } from '../../session/open';
import { withKeys } from '../../lib/listKeys';
import { createContext, Fragment, useCallback, useContext, memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import ReactMarkdown, { type Components, type Options } from 'react-markdown';
import type { PluggableList } from 'unified';
import 'katex/dist/katex.min.css';
import { highlight } from '../../lib/highlight';
import { linkMark } from '../../lib/format';
import { basename } from '../../lib/paths';
import { directiveFromHref, parseDirectives, urlTransform, type Directive } from '../../lib/codexDirectives';
import { normalizeMath, rehypePlugins } from '../../lib/markdownMath';
import { rehypeWords } from '../../lib/rehypeWords';
import { watchFades } from '../../lib/stepFade';
import { useStreamedSegments, viewRemarkPlugins } from './markdownRuns';
import { codeMayGrow, type MarkdownTree } from '../../lib/markdownBlocks';
import { useCopyConfirm } from '../../session/copyConfirm';
import { giveBackToComposer } from '../../store/send';
import { useStore } from '../../store/core';
import { AgentChatContext } from '../agents/AgentChatContext';
import { Copy, Check, WrapText, FileText } from '../ui/icons';
import { ZoomableImage } from '../ui/ImageLightbox';
import { SkillLink } from './SkillLink';
import { InlineCodePath } from './MessagePathLink';
import { skillPath } from '../../lib/skills';
import { Visualization } from './Visualization';
import { PullRequestLink } from './PullRequestLink';
import { PullRequestReferenceTime } from './prReferenceTime';
import { historicalPullRequestUrl, pullRequestUrl } from '../../../shared/pullRequest.mjs';
import { ISSUE_REF_PROPERTY, remarkIssueRefs } from '../../lib/issueRefs';
import { useIssueRefs } from '../../lib/chatRepo';
import { chatIdFromHref } from '../../lib/chatLink';
import { ChatLink } from './ChatLink';

/**
 * Where each reveal step started, moved from the reply's text into the Markdown source rendered from it. Rewriting
 * directives and math changes lengths: a step after the first change moves by the length the rewrite added, which
 * only places fades, never text.
 */
export function sourceSteps(steps: readonly number[], text: string, source: string): readonly number[] {
  if (source === text || !steps.length) return steps;
  let same = 0;
  while (same < text.length && same < source.length && text[same] === source[same]) same++;
  const shift = source.length - text.length;
  return steps.map((s) => (s <= same ? s : Math.min(source.length, Math.max(same, s + shift))));
}

/** A run's reveal steps: where each started relative to the run, and when it showed (times[i] may be missing). */
export interface RunSteps {
  steps: number[];
  times: number[];
}

/** A run's steps, relative to its start: the step its text began in (at 0 or below), then each one inside it. */
export function runSteps(steps: readonly number[], times: readonly number[], start: number, end: number): RunSteps {
  const out: RunSteps = { steps: [], times: [] };
  let before = -1;
  steps.forEach((s, i) => {
    if (s <= start) before = i;
    else if (s < end) {
      out.steps.push(s - start);
      out.times.push(times[i]);
    }
  });
  if (before !== -1) {
    out.steps.unshift(steps[before] - start);
    out.times.unshift(times[before]);
  }
  return out;
}

const sameNumbers = (a: readonly number[], b: readonly number[]) => a.length === b.length && a.every((n, i) => Object.is(n, b[i]));

/** Whether two runs' steps are the same, so a closed run whose steps did not change stays memoized. */
export function sameRunSteps(a: RunSteps, b: RunSteps): boolean {
  return sameNumbers(a.steps, b.steps) && sameNumbers(a.times, b.times);
}

const NO_STEPS: readonly number[] = [];

/** The text of a run whose last block may still grow, so a code block at its end knows it is still streaming. */
const OpenRun = createContext<string | null>(null);

export const Markdown = memo(function Markdown({
  text,
  cwd,
  animate = false,
  streaming = false,
  steps = NO_STEPS,
  stepTimes = NO_STEPS,
}: {
  text: string;
  cwd?: string | null;
  animate?: boolean;
  streaming?: boolean;
  /** Where each reveal step started in `text` (useSmoothText): a step's words fade in one after another. */
  steps?: readonly number[];
  /** When each step showed, on the document timeline: its words fade in from then (stepFade.ts). */
  stepTimes?: readonly number[];
}) {
  const chatId = useContext(AgentChatContext);
  const completedAt = useContext(PullRequestReferenceTime);
  const { markdown, followups } = useMemo(() => parseDirectives(text, streaming), [text, streaming]);
  const source = useMemo(() => normalizeMath(markdown), [markdown]);
  const placed = sourceSteps(steps, text, source);
  // each word fades on the timeline from its moment, once per element: one mounted again carries on its fade
  const root = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => (animate && root.current ? watchFades(root.current) : undefined), [animate]);
  const segments = useStreamedSegments(source, streaming);
  // a chat on a machine: its links open there, and nothing here is looked up in its folder (no skills, repository or local images)
  const remote = useContext(RemoteFolderContext);
  const linkCwd = remote ? remoteCwd(remote.machineId, remote.folder) : cwd;
  const issueRefs = useIssueRefs(source, remote ? null : cwd);
  // stable while the text grows, so a run that did not change is not parsed again
  const remarkPlugins = useMemo<NonNullable<Options['remarkPlugins']>>(
    () => [...viewRemarkPlugins, [remarkIssueRefs, issueRefs]],
    [issueRefs],
  );
  // React treats a new renderer function as a new component type. Keep these stable
  // as text grows so tables, links and code retain their DOM, state and animations.
  const components = useMemo<Components>(
    () => ({
      a: ({ href, children, node }) => {
        const directive = directiveFromHref(href);
        if (directive) return <DirectiveChip directive={directive} cwd={linkCwd} />;
        // another chat, as an agent links a linked session: a pill that opens it here
        const chat = chatIdFromHref(href);
        if (chat)
          return (
            <ChatLink id={chat} className="peer-chat-link md-chat-link">
              {children}
            </ChatLink>
          );
        const skill = !remote && href && skillPath(href, cwd, true);
        if (skill) return <SkillLink path={skill}>{children}</SkillLink>;
        // an issue reference (#12) keeps its words, even when it names a pull request, and goes without a favicon
        const issueRef = node?.properties?.[ISSUE_REF_PROPERTY] !== undefined;
        const pullRequest = !issueRef && pullRequestUrl(href);
        if (pullRequest) {
          const url = historicalPullRequestUrl(pullRequest, completedAt);
          const target = url === pullRequest ? href! : `${url}${href!.match(/[?#].*$/)?.[0] ?? ''}`;
          return <MessagePullRequestLink url={url} href={target} cwd={linkCwd} />;
        }
        return (
          <a
            href={href}
            onClick={(e) => {
              e.preventDefault();
              if (!href) return;
              openMessageLink(href, linkCwd, e, true);
            }}
            title={href}
          >
            {href && !issueRef && <Favicon href={href} />}
            <InLink.Provider value={true}>{children}</InLink.Provider>
          </a>
        );
      },
      code: ({ className, children, node, ...rest }) => {
        const m = /language-([\w+#-]+)/.exec(className || '');
        const raw = String(children ?? '');
        const isBlock = !!m || raw.includes('\n');
        if (!isBlock) return <InlineCode text={raw} cwd={linkCwd} />;
        return <MarkdownCodeBlock code={raw.replace(/\n$/, '')} lang={m?.[1] ?? 'text'} at={node?.position} />;
      },
      img: ({ src, alt }) => {
        // Markdown images always carry a string src (raw HTML, which could pass a Blob, is not enabled)
        const url = imageUrl(src as string, linkCwd);
        return url ? <ZoomableImage className="md-image" src={url} alt={alt} /> : null;
      },
      pre: ({ children }) => <>{children}</>,
      table: ({ children }) => (
        <div className="md-table-wrap">
          <table>{children}</table>
        </div>
      ),
    }),
    [cwd, linkCwd, remote, completedAt],
  );
  const transformUrl = useCallback(
    (url: string, key: string) =>
      (key === 'src' && /^(file:|data:image\/|[A-Za-z]:(?:[\\/]|%2f|%5c))/i.test(url)) ||
      (key === 'href' && (/^file:/i.test(url) || (!remote && skillPath(url, cwd, true)) || !!chatIdFromHref(url)))
        ? url
        : urlTransform(url),
    [cwd, remote],
  );
  return (
    <div ref={root} className={animate ? 'md md-animated' : 'md'}>
      {segments.map((segment, i) => (
        <Fragment key={segment.start}>
          {/* one parse puts a line break between top-level blocks; so do runs, for the same DOM */}
          {segment.start > 0 && '\n'}
          <MarkdownBlocks
            text={segment.text}
            open={streaming && i === segments.length - 1}
            animate={animate && segment.words}
            steps={runSteps(placed, stepTimes, segment.start, segment.start + segment.text.length)}
            remarkPlugins={remarkPlugins}
            components={components}
            transformUrl={transformUrl}
          />
        </Fragment>
      ))}
      {followups.length > 0 && (
        <div className="md-followups">
          {withKeys(followups, (f) => JSON.stringify([f.label, f.attrs.prompt])).map(({ key, item: f }) => (
            <button
              key={key}
              className="btn-pill md-followup"
              title={f.attrs.prompt}
              onClick={() => {
                const text = f.attrs.prompt || f.label;
                if (chatId) giveBackToComposer(chatId, text);
                else window.dispatchEvent(new CustomEvent('composer-insert', { detail: text }));
              }}
            >
              {f.label || f.attrs.prompt}
            </button>
          ))}
        </div>
      )}
    </div>
  );
});

/**
 * A run of top-level blocks, parsed on its own. Memoized, so a run whose text did not change is not parsed again.
 * `open` marks the last run of a streaming reply, whose last block may still grow.
 */
const MarkdownBlocks = memo(
  function MarkdownBlocks({
    text,
    open,
    animate,
    steps,
    remarkPlugins,
    components,
    transformUrl,
  }: {
    text: string;
    open: boolean;
    animate: boolean;
    /** The run's steps (runSteps). */
    steps: RunSteps;
    remarkPlugins: NonNullable<Options['remarkPlugins']>;
    components: Components;
    transformUrl: (url: string, key: string) => string | null | undefined;
  }) {
    const animatedRehypePlugins = useMemo<PluggableList>(() => [...rehypePlugins, [rehypeWords, steps]], [steps]);
    return (
      <OpenRun.Provider value={open ? text : null}>
        <ReactMarkdown
          remarkPlugins={remarkPlugins}
          rehypePlugins={animate ? animatedRehypePlugins : rehypePlugins}
          urlTransform={transformUrl}
          components={components}
        >
          {text}
        </ReactMarkdown>
      </OpenRun.Provider>
    );
  },
  // steps are compared by value: a run's are rebuilt every render, and only the open run's change
  (prev, next) =>
    prev.text === next.text &&
    prev.open === next.open &&
    prev.animate === next.animate &&
    prev.remarkPlugins === next.remarkPlugins &&
    prev.components === next.components &&
    prev.transformUrl === next.transformUrl &&
    sameRunSteps(prev.steps, next.steps),
);

/** Inline `:codex-file-citation` / `:codex-annotation` directives (see lib/codexDirectives). */
function DirectiveChip({ directive: { name, attrs }, cwd }: { directive: Directive; cwd?: string | null }) {
  const remote = parseRemoteCwd(cwd);
  // a visualization is a file on this Mac: for a chat on a machine there is none to draw
  if (name === 'visualize') return remote ? null : <Visualization path={attrs.path} mode={attrs.mode} title={attrs.title} cwd={cwd} />;
  if (name === 'annotation' && attrs.index)
    return (
      <sup className="md-annotation" title={`Answers annotation ${attrs.index}`}>
        {attrs.index}
      </sup>
    );
  if (name === 'file-citation' && attrs.path) {
    const path = remote ? (remotePathOf(attrs.path, remote.folder) ?? attrs.path) : absPath(attrs.path, cwd);
    const skill = remote ? null : skillPath(path, cwd);
    if (skill) return <SkillLink path={skill} />;
    const page = attrs.page_number;
    return (
      <a
        className="md-file-chip"
        href={path}
        title={path}
        onClick={(e) => {
          e.preventDefault();
          openMessageLink(path, cwd, e);
        }}
      >
        <FileText size={12} strokeWidth={1.8} />
        {basename(path)}
        {page && <span className="md-file-chip-page">p. {page}</span>}
      </a>
    );
  }
  return null;
}

/** A PR link reads its status once its run can no longer change it: a streaming autolink grows digit by digit. */
function MessagePullRequestLink({ url, href, cwd }: { url: string; href: string; cwd?: string | null }) {
  const live = useContext(OpenRun) === null;
  return <PullRequestLink url={url} href={href} live={live} onOpen={(e) => openMessageLink(href, cwd, e, true)} />;
}

function Favicon({ href }: { href: string }) {
  const mark = linkMark(href);
  if (!mark) return null;
  return (
    // the letter is drawn by CSS from data-letter, so it is not text: not copied, not read, not in innerText
    <span className="md-favicon" aria-hidden="true" data-letter={mark.letter} style={{ background: `hsl(${mark.hue} 45% 45%)` }} />
  );
}

/** Local image paths (absolute, file:// or relative to the chat's folder) load through codex-asset://. */
function imageUrl(src: string, cwd?: string | null) {
  if (!src || /^(https?|data|blob|codex-asset):/i.test(src)) return src;
  // a file on a machine is not an image this Mac can load
  if (parseRemoteCwd(cwd)) return '';
  const link = localLinkParts(src, true);
  let p = decodeLinkPath(link.path, link, cwd);
  // Decode the image URL before joining the literal chat folder path.
  if (!isAbsolutePath(p)) {
    if (!cwd) return src;
    p = joinPath(cwd, p);
  }
  return assetUrl(p) + link.search + link.fragment;
}

/** Inside a Markdown link: a path in its label is plain code, since a link can't hold another link. */
const InLink = createContext(false);

function InlineCode({ text, cwd }: { text: string; cwd?: string | null }) {
  const inLink = useContext(InLink);
  const skill = parseRemoteCwd(cwd) ? null : skillPath(text, cwd);
  if (skill && !inLink) return <SkillLink path={skill} />;
  if (inLink) return <code className="inline-code">{text}</code>;
  return <InlineCodePath text={text} cwd={cwd} />;
}

/** A message's code block: it is still streaming while it may still grow at the end of a run that may still grow. */
function MarkdownCodeBlock({ code, lang, at }: { code: string; lang: string; at: MarkdownTree['position'] }) {
  const run = useContext(OpenRun);
  return <CodeBlock code={code} lang={lang} streaming={run !== null && codeMayGrow(run, at)} />;
}

/**
 * A block that is still streaming shows its plain text. Highlighting every version of a growing block would run Shiki
 * on the whole block again and again, and cache each version, for a result that is stale before it shows; it is
 * highlighted once, when it stops growing.
 */
export function CodeBlock({
  code,
  lang,
  showHeader = true,
  maxHeight,
  streaming = false,
}: {
  code: string;
  lang: string;
  showHeader?: boolean;
  maxHeight?: number;
  streaming?: boolean;
}) {
  const dark = useResolvedDark();
  const wrapPref = useStore((s) => s.prefs.wrapCode);
  const [wrap, setWrap] = useState(wrapPref);
  const [highlighted, setHighlighted] = useState<{ code: string; lang: string; dark: boolean; html: string } | null>(null);
  const { copied, copy } = useCopyConfirm();
  useEffect(() => {
    if (streaming) return;
    let alive = true;
    const timer = setTimeout(() => {
      highlight(code, lang, dark).then(
        (html) => alive && setHighlighted({ code, lang, dark, html }),
        () => {
          /* the plain code stays shown */
        },
      );
    });
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [code, lang, dark, streaming]);
  return (
    <div className={`code-block ${wrap ? 'wrap' : ''}`}>
      {showHeader && (
        <div className="code-header">
          <span className="code-lang">{lang === 'text' ? '' : lang}</span>
          <div className="code-actions">
            <button className="icon-btn xs" onClick={() => setWrap((w) => !w)} title="Toggle wrap">
              <WrapText size={13} />
            </button>
            {/* the icon is the confirmation; the title stays the action, so the button keeps one accessible name */}
            <button className="icon-btn xs" onClick={() => copy(code)} title="Copy">
              {copied === code ? <Check size={13} className="copy-check" /> : <Copy size={13} />}
            </button>
          </div>
        </div>
      )}
      <div className="code-body" style={{ maxHeight }}>
        {highlighted?.code === code && highlighted.lang === lang && highlighted.dark === dark ? (
          <div dangerouslySetInnerHTML={{ __html: highlighted.html }} />
        ) : (
          <pre className="shiki-fallback">
            <code>{code}</code>
          </pre>
        )}
      </div>
    </div>
  );
}

export function useResolvedDark() {
  const theme = useStore((s) => s.prefs.theme);
  const sysDark = useStore((s) => s.dark);
  return theme === 'dark' || (theme === 'system' && sysDark);
}
