// The skill pane: a referenced skill's document and metadata, shown beside the chat.

import { useEffect, useMemo, useState } from 'react';
import { native } from '../../lib/native';
import { copyText } from '../../session/clipboard';
import { revealPath } from '../../session/open';
import { dirname, splitPath } from '../../lib/paths';
import { skillDocument } from '../../lib/skills';
import { CodeBlock, Markdown } from '../markdown/Markdown';
import { ChevronRight, Copy, FolderOpen, Spinner } from '../ui/icons';
import { withKeys } from '../../lib/listKeys';
import { errorText } from '../../lib/ignored';

/** Inspect the exact skill referenced in a chat, without leaving the conversation. */
export function SkillPanel({ path }: { path: string }) {
  const [source, setSource] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showSource, setShowSource] = useState(false);
  useEffect(() => {
    let alive = true;
    setSource(null);
    setError(null);
    setShowSource(false);
    native.fs
      .readText(path)
      .then((text) => {
        if (!alive) return;
        if (text == null) setError('This skill could not be read. It may have been moved or removed.');
        else if (text.length > 400_000) setError('This skill is too large to preview. Open its folder to inspect the file.');
        else setSource(text);
      })
      .catch((e) => alive && setError(errorText(e)));
    return () => {
      alive = false;
    };
  }, [path]);
  const doc = useMemo(() => skillDocument(source ?? ''), [source]);
  return (
    <section className="skill-pane" aria-label="Skill details">
      <div className="skill-pane-toolbar">
        <div className="skill-breadcrumb" title={path} aria-label={path}>
          {withKeys(splitPath(path), (part) => part).map(({ key, item: part, index }) => (
            <span key={key}>
              {index > 0 && <ChevronRight size={12} aria-hidden="true" />}
              {part}
            </span>
          ))}
        </div>
        <div className="skill-pane-actions">
          <button className="btn-pill" disabled={source == null} aria-pressed={showSource} onClick={() => setShowSource((v) => !v)}>
            {showSource ? 'View rendered' : 'View source'}
          </button>
          <button className="icon-btn" title="Copy path" aria-label="Copy skill path" onClick={() => copyText(path, 'Copied path')}>
            <Copy size={16} />
          </button>
          <button className="icon-btn" title="Open folder" aria-label="Reveal skill in folder" onClick={() => revealPath(path)}>
            <FolderOpen size={16} />
          </button>
        </div>
      </div>
      <div className="skill-pane-content">
        {error ? (
          <div className="empty-state" role="alert">
            {error}
          </div>
        ) : source == null ? (
          <div className="center-pad" role="status" aria-label="Loading skill">
            <Spinner size={16} />
          </div>
        ) : showSource ? (
          <CodeBlock code={source} lang="markdown" />
        ) : (
          <>
            {doc.metadata.length > 0 && (
              <div className="skill-metadata">
                <div className="skill-metadata-label">Metadata</div>
                <dl>
                  {doc.metadata.map(([key, value]) => (
                    <div key={key}>
                      <dt>{key}</dt>
                      <dd>{value}</dd>
                    </div>
                  ))}
                </dl>
              </div>
            )}
            <Markdown text={doc.body} cwd={dirname(path)} />
          </>
        )}
      </div>
    </section>
  );
}
