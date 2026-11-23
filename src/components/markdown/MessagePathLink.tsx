// A path a reply writes as inline code, or a prompt as `@path`, once main finds a file or folder there: a link as Claude's app shows one, opening it on a click and offering the path menu on a right-click.

import { openFile, openMessagePath } from '../../session/open';
import { pathCandidate, useMessagePath, type LineSpan, type MessagePath } from '../../lib/messagePaths';
import { modKey } from '../../lib/platform';
import { useFileMenu } from '../ui/FileMenu';
import { MenuItem } from '../ui/Popover';
import type { ReactNode } from 'react';

/** Inline code as a path link when it names something that is there, else plain code. */
export function InlineCodePath({ text, cwd }: { text: string; cwd?: string | null }) {
  const candidate = pathCandidate(text);
  const found = useMessagePath(candidate?.path, cwd);
  if (!candidate || !found) return <code className="inline-code">{text}</code>;
  return (
    <PathLink text={text} path={candidate.path} found={found} span={candidate} cwd={cwd} className="md-path">
      <code>{text}</code>
    </PathLink>
  );
}

/** An `@path` a prompt names, as accent text with its `@` (Claude's app); plain text while nothing is found there. */
export function FileMentionLink({ token, path, cwd }: { token: string; path: string; cwd?: string | null }) {
  const candidate = pathCandidate(path);
  const found = useMessagePath(candidate?.path, cwd);
  if (!candidate || !found) return <>{token}</>;
  return (
    <PathLink text={path} path={candidate.path} found={found} span={candidate} cwd={cwd} className="bubble-file-link">
      {token}
    </PathLink>
  );
}

function PathLink({
  text,
  path,
  found,
  span,
  cwd,
  className,
  children,
}: {
  text: string;
  path: string;
  found: MessagePath;
  span: LineSpan;
  cwd?: string | null;
  className: string;
  children: ReactNode;
}) {
  const file = found.kind === 'file';
  const menu = useFileMenu(found.path, {
    extra: file && <MenuItem onSelect={() => openFile(found.path)}>Open with default app</MenuItem>,
  });
  return (
    <>
      {/* a real link, so Tab reaches it and Enter opens it like a click */}
      <a
        className={className}
        href={text}
        title={found.path}
        {...menu.target}
        onClick={(e) => {
          e.preventDefault();
          // asked as written, so the click's answer (gone by now, say) is the one this link shows
          void openMessagePath(path, cwd, { line: span.line, endLine: span.endLine }, modKey(e));
        }}
      >
        {children}
      </a>
      {menu.menu}
    </>
  );
}
