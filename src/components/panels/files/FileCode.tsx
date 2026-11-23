// A text file's code in the side pane, editable in place: highlighted source with a transparent editor over it, its cited lines marked, find in file, go to line and word wrap.
import { forwardRef, useEffect, useImperativeHandle, useRef, useState, type KeyboardEvent } from 'react';
import { highlight } from '../../../lib/highlight';
import { setFileDraft } from '../../../lib/fileDrafts';
import { withKeys } from '../../../lib/listKeys';
import { useEffectOn } from '../../../lib/effects';
import { FileFindBar, GoToLineBar } from './FileFind';
import { Spinner } from '../../ui/icons';

/** How long typing pauses before the edit is colored again; until then it shows as plain text, aligned with the editor. */
export const RECOLOR_MS = 120;

export type FileCodeHandle = { find: () => void; goToLine: () => void };

type Props = {
  path: string;
  name: string;
  /** what an edit is made against: the draft's own base, else the file's text on disk */
  base: string;
  /** what the editor shows: the draft, else the file's text */
  text: string;
  lang: string;
  dark: boolean;
  wrap: boolean;
  line?: number;
  endLine?: number;
  onSave: () => void;
};

/** Each line as its own `.line` span, as the highlighter draws them, so marks and find work on either. */
function PlainCode({ text }: { text: string }) {
  return (
    <pre className="shiki-fallback">
      <code>
        {withKeys(text.split('\n'), (t) => t).map(({ key, item, index }) => [
          index > 0 ? '\n' : '',
          <span key={key} className="line">
            {item}
          </span>,
        ])}
      </code>
    </pre>
  );
}

/** The character offset where 1-based `line` starts in `text` (its end for a line past the last). */
export function lineOffset(text: string, line: number): number {
  let at = 0;
  for (let n = 1; n < line; n++) {
    const next = text.indexOf('\n', at);
    if (next < 0) return text.length;
    at = next + 1;
  }
  return at;
}

/** What Tab inserts: a tab in a file indented with tabs, else two spaces. */
export const indentUnit = (text: string) => (/^\t/m.test(text) ? '\t' : '  ');

export const FileCode = forwardRef<FileCodeHandle, Props>(function FileCode(
  { path, name, base, text: given, lang, dark, wrap, line, endLine, onSave },
  ref,
) {
  // shown, colored and edited with \n endings, as the editor field reads them; a draft keeps the file's own (fileDrafts.ts)
  const text = given.replace(/\r\n/g, '\n');
  const [colored, setColored] = useState<{ text: string; html: string } | null>(null);
  const [failed, setFailed] = useState(false);
  const [find, setFind] = useState<number | null>(null);
  const [goTo, setGoTo] = useState(false);
  // a go-to-line jump marks its line in place of the cited ones
  const [jump, setJump] = useState<number | null>(null);
  const content = useRef<HTMLDivElement>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const editor = useRef<HTMLTextAreaElement>(null);
  useImperativeHandle(ref, () => ({ find: () => setFind((k) => (k ?? 0) + 1), goToLine: () => setGoTo(true) }), []);
  // a newly cited line or range takes the place of the last go-to-line jump
  useEffectOn([line, endLine], () => {
    setJump(null);
  });

  // the text is colored at once, except an edit while typing (after a pause); a theme change colors it again at once
  const coloredText = useRef<string | null>(null);
  useEffect(() => {
    let alive = true;
    setFailed(false);
    const run = () =>
      highlight(text, lang, dark).then(
        (html) => {
          if (!alive) return;
          coloredText.current = text;
          setColored({ text, html });
        },
        () => alive && setFailed(true),
      );
    const typing = coloredText.current !== null && coloredText.current !== text;
    const timer = typing ? setTimeout(run, RECOLOR_MS) : (run(), undefined);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [text, lang, dark]);
  const html = colored?.text === text && !failed ? colored.html : null;

  // mark the go-to line, else the cited line or range, again after each drawing; scrolled to once per target, so
  // coloring the code after it is drawn plain does not move the view again
  const scrolledTo = useRef<string | null>(null);
  useEffectOn([html, failed, line, endLine, jump], () => {
    const lines = content.current?.querySelectorAll('.line');
    if (!lines) return;
    lines.forEach((el) => el.classList.remove('file-preview-target'));
    const [first, last] = jump ? [jump, jump] : [line ?? 0, Math.max(line ?? 0, endLine ?? 0)];
    const cited = first > 0 ? [...lines].slice(first - 1, last) : [];
    for (const el of cited) el.classList.add('file-preview-target');
    const target = `${first}:${last}`;
    if (scrolledTo.current === target) return;
    scrolledTo.current = target;
    if (cited[0]) cited[0].scrollIntoView({ block: cited.length > 1 ? 'start' : 'center', inline: 'nearest' });
    else if (scroller.current) scroller.current.scrollTop = 0;
  });

  const go = (n: number) => {
    setGoTo(false);
    setJump(n);
    const at = lineOffset(text, n);
    editor.current?.focus();
    editor.current?.setSelectionRange(at, at);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.nativeEvent.isComposing) return;
    // ⌘S, or Ctrl-S off the Mac (on the Mac it does nothing else in a text field)
    if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 's') {
      e.preventDefault();
      onSave();
    } else if (e.key === 'Tab' && !e.shiftKey && !e.metaKey && !e.ctrlKey && !e.altKey) {
      // Tab indents, as in an editor (⇧Tab still leaves the field); the browser's own insert keeps undo working
      e.preventDefault();
      document.execCommand('insertText', false, indentUnit(text));
    }
  };

  // the file is drawn once it is first colored (or coloring failed); later edits show plain until colored again
  if (!colored && !failed)
    return (
      <div className="center-pad">
        <Spinner size={16} />
      </div>
    );
  return (
    <>
      {find !== null && <FileFindBar root={content} version={html ?? text} focusKey={find} onClose={() => setFind(null)} />}
      {goTo && <GoToLineBar lines={text.split('\n').length} onGo={go} onClose={() => setGoTo(false)} />}
      <div
        ref={scroller}
        className={`file-preview file-editor ${wrap ? 'wrap' : ''}`}
        onKeyDown={(e) => {
          // ⌃G: go to line, on every platform (as in editors)
          if (e.ctrlKey && !e.metaKey && !e.altKey && e.key.toLowerCase() === 'g') {
            e.preventDefault();
            setGoTo(true);
          }
        }}
      >
        <div className="file-editor-stack">
          {html ? (
            <div ref={content} className="file-editor-code" aria-hidden dangerouslySetInnerHTML={{ __html: html }} />
          ) : (
            <div ref={content} className="file-editor-code" aria-hidden>
              <PlainCode text={text} />
            </div>
          )}
          <textarea
            ref={editor}
            className="file-editor-input"
            aria-label={`Edit ${name}`}
            value={text}
            wrap={wrap ? 'soft' : 'off'}
            spellCheck={false}
            autoCapitalize="off"
            autoComplete="off"
            autoCorrect="off"
            onChange={(e) => setFileDraft(path, base, e.target.value)}
            onKeyDown={onKeyDown}
          />
        </div>
      </div>
    </>
  );
});
