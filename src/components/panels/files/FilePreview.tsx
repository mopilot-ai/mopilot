// A file shown in the side pane (a Files tab or a file a reply cites): image, media, document, table, HTML and Markdown previews, and its source, editable in place, with Save and Discard.

import { dirname, fileName, relPath } from '../../../lib/paths';
import { isWin } from '../../../lib/platform';
import { useEffect, useRef, useState } from 'react';
import { native } from '../../../lib/native';
import { langFromPath } from '../../../lib/highlight';
import { confirmDiscard, saveFileDraft, setFileDraft, useFileDraft } from '../../../lib/fileDrafts';
import { Markdown, useResolvedDark } from '../../markdown/Markdown';
import { Ellipsis, ExternalLink, RotateCw, Search, Spinner, WrapText } from '../../ui/icons';
import { LangIcon } from '../DiffPanel';
import { openPath } from '../../../session/open';
import { useFileMenu } from '../../ui/FileMenu';
import { MenuItem } from '../../ui/Popover';
import { errorText } from '../../../lib/ignored';
import { visiblePoll } from '../../../lib/visiblePoll';
import { useEffectOn } from '../../../lib/effects';
import { setPrefs, toast, useStore } from '../../../store/core';
import { FileImagePreview } from '../FileImagePreview';
import { filePreviewKind, isBinaryPreviewPath, previewExtension } from '../../../../shared/filePreview.mjs';
import { FileMediaPreview } from '../FileMediaPreview';
import { FileDocumentPreview } from '../FileDocumentPreview';
import { PreviewError } from '../PreviewStatus';
import { PreviewTable } from '../PreviewTable';
import { delimitedSheet } from '../../../lib/previewTables';
import { previewDocument } from '../../../lib/visualization';
import { useLocalAssets } from '../../../lib/previewAssets';
import { FileCode, type FileCodeHandle } from './FileCode';
import { PreviewSwap } from '../PreviewSwap';
import { FileCanvasPreview } from '../FileCanvasPreview';

/** How often a shown file is read again while the window shows. */
export const FILE_WATCH_MS = 2000;

export type FilePreviewProps = {
  path: string;
  cwd: string;
  line?: number;
  endLine?: number;
  /** a new value scrolls to the cited lines again (the same line asked for twice) */
  seq?: number;
  /** Completed writes refresh this exact path while preserving its last valid preview. */
  revision?: string;
  /** shows the file in the Files pane's tree ("Reveal in file tree") */
  onReveal?: () => void;
};

export function FilePreview(props: FilePreviewProps) {
  return <FilePreviewContent key={props.path} {...props} />;
}

function FilePreviewContent({ path, cwd, line, endLine, seq, revision, onReveal }: FilePreviewProps) {
  const dark = useResolvedDark();
  const lang = langFromPath(path);
  const kind = filePreviewKind(path);
  const isMarkdown = lang === 'markdown';
  const isRendered = isMarkdown || kind === 'html' || kind === 'table' || kind === 'canvas';
  const externalContent = kind === 'image' || kind === 'audio' || kind === 'video' || isBinaryPreviewPath(path);
  const wrap = useStore((s) => !!s.prefs.filesWrap);
  const { draft, saving } = useFileDraft(path);
  const [attempt, setAttempt] = useState(0);
  const previewRevision = attempt ? `${revision ?? ''}:reload${attempt}` : revision;
  const [sourceRevision, setSourceRevision] = useState(revision);
  const [source, setSource] = useState<string | null>(null);
  // A cited source line opens in source mode so it can still be highlighted and scrolled into view. Another file or
  // line picks its mode again while rendering, so its first frame (and first highlight) is already in that mode.
  const cited = !!line && line > 0;
  const [showSource, setShowSource] = useState(cited);
  const [modeFor, setModeFor] = useState({ path, line, endLine, seq });
  if (modeFor.path !== path || modeFor.line !== line || modeFor.endLine !== endLine || modeFor.seq !== seq) {
    setModeFor({ path, line, endLine, seq });
    if (cited) setShowSource(true);
  }
  const [err, setErr] = useState<string | null>(null);
  // each read of an HTML file reads the stylesheets and images it inlines again too, so edits to them show
  const [reads, setReads] = useState(0);
  const code = useRef<FileCodeHandle>(null);
  const root = useRef<HTMLDivElement>(null);
  const readEpoch = useRef(0);
  const pendingRead = useRef(false);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const reread = async () => {
    if (!alive.current) return;
    const epoch = ++readEpoch.current;
    pendingRead.current = true;
    try {
      const text = await native.fs.readText(path);
      if (!alive.current || readEpoch.current !== epoch) return;
      if (text == null || text.includes('\0')) return setErr('This file can’t be previewed');
      if (text.length > 400_000) return setErr('File is too large to preview');
      setSource(text);
      setSourceRevision(previewRevision);
      if (kind === 'html') setReads((n) => n + 1);
      setErr(null);
    } catch (error) {
      if (alive.current && readEpoch.current === epoch) setErr(errorText(error ?? '') || 'Could not read file');
    } finally {
      if (readEpoch.current === epoch) pendingRead.current = false;
    }
  };
  const readLatest = useRef(reread);
  readLatest.current = reread;
  useEffectOn([externalContent, revision, attempt], () => {
    if (externalContent) return;
    void reread();
    return () => {
      ++readEpoch.current;
    };
  });
  // Polling never supersedes an in-flight explicit read; a new published revision does.
  useEffectOn([externalContent], () => {
    if (externalContent) return;
    return visiblePoll('file-view-watch', FILE_WATCH_MS, () => {
      if (!pendingRead.current) void readLatest.current();
    });
  });
  // ⌘F with focus in this file (src/session/appShortcuts.ts sends it here instead of the chat's find)
  useEffect(() => {
    const el = root.current;
    const onFind = () => code.current?.find();
    el?.addEventListener('find-in-file', onFind);
    return () => el?.removeEventListener('find-in-file', onFind);
  }, []);

  const text = draft?.text ?? source;
  const html = useLocalAssets(kind === 'html' && !showSource ? text : null, path, { refresh: reads, tag: sourceRevision });
  const codeShown = source != null && !externalContent && (!isRendered || showSource);
  // a draft begun from other text than the file now holds: an agent or another app wrote it meanwhile
  const stale = !!draft && source != null && draft.base !== source;
  const save = () =>
    void saveFileDraft(path).then(
      (result) => {
        if (result === 'saved') void readLatest.current();
      },
      (e) => toast(`Couldn't save ${fileName(path, isWin)}: ${errorText(e)}`, 'error'),
    );
  const menu = useFileMenu(path, {
    extra: (
      <>
        {codeShown && <MenuItem onSelect={() => code.current?.goToLine()}>Go to line…</MenuItem>}
        {onReveal && <MenuItem onSelect={onReveal}>Reveal in file tree</MenuItem>}
      </>
    ),
  });
  return (
    <div ref={root} className="files-pane file-view">
      <div className="file-preview-head">
        <LangIcon path={path} />
        <span className="file-node-name" title={path}>
          {relPath(path, cwd)}
        </span>
        {draft && (
          <>
            <span className="file-dirty" role="status">
              Unsaved changes
            </span>
            <button className="btn-pill" disabled={saving} onClick={() => confirmDiscard([path])}>
              Discard
            </button>
            <button className="btn-pill primary" disabled={saving} onClick={save}>
              {saving ? 'Saving…' : 'Save'}
            </button>
          </>
        )}
        {isRendered && (
          <button
            className="btn-pill file-preview-toggle"
            disabled={source == null}
            aria-pressed={showSource}
            onClick={() => setShowSource((v) => !v)}
          >
            {showSource ? 'View rendered' : 'View source'}
          </button>
        )}
        {codeShown && (
          <>
            <button className="cp-tool" onClick={() => code.current?.find()} aria-label="Find in file" title="Find in file">
              <Search size={14} />
            </button>
            <button
              className={`cp-tool ${wrap ? 'on' : ''}`}
              onClick={() => setPrefs({ filesWrap: !wrap })}
              aria-label="Word wrap"
              aria-pressed={wrap}
              title="Word wrap"
            >
              <WrapText size={14} />
            </button>
          </>
        )}
        <button className="cp-tool" onClick={() => openPath(path)} aria-label="Open file">
          <ExternalLink size={14} />
        </button>
        <button className="cp-tool" onClick={() => setAttempt((n) => n + 1)} aria-label="Refresh preview">
          <RotateCw size={14} />
        </button>
        <button className="cp-tool" title="File actions" {...menu.trigger}>
          <Ellipsis size={15} />
        </button>
        {menu.menu}
      </div>
      {stale && (
        <div className="file-stale" role="alert">
          <span>This file changed since you started editing it.</span>
          <button className="btn-pill" onClick={() => confirmDiscard([path]) && setAttempt((n) => n + 1)}>
            Reload
          </button>
          <button className="btn-pill" onClick={() => setFileDraft(path, source!, draft!.text)}>
            Keep my edits
          </button>
        </div>
      )}
      {err && source != null && (
        <PreviewError message={`${err}. Showing the last readable version.`} onRetry={() => setAttempt((n) => n + 1)} />
      )}
      {kind === 'image' ? (
        <PreviewSwap revision={previewRevision}>{(ready) => <FileImagePreview path={path} {...ready} />}</PreviewSwap>
      ) : kind === 'audio' || kind === 'video' ? (
        <PreviewSwap revision={previewRevision}>{(ready) => <FileMediaPreview path={path} kind={kind} {...ready} />}</PreviewSwap>
      ) : isBinaryPreviewPath(path) ? (
        <PreviewSwap revision={previewRevision}>{(ready) => <FileDocumentPreview path={path} {...ready} />}</PreviewSwap>
      ) : err && source == null ? (
        <PreviewError message={err} onRetry={() => setAttempt((n) => n + 1)} />
      ) : source == null || text == null || (kind === 'html' && !showSource && html == null) ? (
        <div className="center-pad">
          <Spinner size={16} />
        </div>
      ) : kind === 'html' && !showSource ? (
        <PreviewSwap value={html!.html} revision={html!.tag}>
          {({ value, onReady, onFailure }) => (
            <iframe
              className="file-document-frame"
              title="HTML preview"
              sandbox="allow-scripts"
              referrerPolicy="no-referrer"
              srcDoc={previewDocument(value!, dark)}
              onLoad={onReady}
              onError={onFailure}
            />
          )}
        </PreviewSwap>
      ) : kind === 'canvas' && !showSource ? (
        <PreviewSwap value={text} revision={previewRevision}>
          {({ value, ...ready }) => <FileCanvasPreview source={value!} path={path} cwd={cwd} dark={dark} {...ready} />}
        </PreviewSwap>
      ) : kind === 'table' && !showSource ? (
        <DelimitedPreview key={`${path}:${attempt}`} source={text} path={path} onRetry={() => setAttempt((n) => n + 1)} />
      ) : isMarkdown && !showSource ? (
        <div className="file-markdown-preview">
          <Markdown text={text} cwd={dirname(path)} />
        </div>
      ) : (
        <FileCode
          key={seq}
          ref={code}
          path={path}
          name={fileName(path, isWin)}
          base={draft?.base ?? source}
          text={text}
          lang={lang}
          dark={dark}
          wrap={wrap}
          line={line}
          endLine={endLine}
          onSave={save}
        />
      )}
    </div>
  );
}

function DelimitedPreview({ source, path, onRetry }: { source: string; path: string; onRetry: () => void }) {
  try {
    return <PreviewTable sheets={[delimitedSheet(source, previewExtension(path) === 'tsv' ? '\t' : ',')]} />;
  } catch {
    return <PreviewError message="Could not read the table. A quoted field may be incomplete." onRetry={onRetry} />;
  }
}
