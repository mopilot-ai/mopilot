// An agent-authored HTML visualization in a sandboxed frame, with its loading and error states.

import { useEffect, useMemo, useState } from 'react';
import { native } from '../../lib/native';
import { absPath, basename, isAbsolutePath } from '../../lib/paths';
import { openPath } from '../../session/open';
import { useFileMenu } from '../ui/FileMenu';
import { useStore } from '../../store/core';
import { loadVisualization, previewDocument, type LoadedVisualization } from '../../lib/visualization';
import { useLocalAssets } from '../../lib/previewAssets';

export function Visualization({ path, mode, title, cwd }: { path?: string; mode?: string; title?: string; cwd?: string | null }) {
  const resolved = path ? absPath(path, cwd) : '';
  const theme = useStore((s) => s.prefs.theme);
  const sysDark = useStore((s) => s.dark);
  const dark = theme === 'dark' || (theme === 'system' && sysDark);
  const [loaded, setLoaded] = useState<LoadedVisualization | null>(null);
  const [expanded, setExpanded] = useState(false);
  // another file starts collapsed, from its first frame
  const [shownFor, setShownFor] = useState(resolved);
  if (shownFor !== resolved) {
    setShownFor(resolved);
    setExpanded(false);
  }
  useEffect(() => {
    let alive = true;
    // cannot reject: an unreadable file is loaded as its error
    void loadVisualization(path, cwd, (file) => native.fs.readText(file)).then((result) => {
      if (alive) setLoaded(result);
    });
    return () => {
      alive = false;
    };
  }, [path, cwd]);
  const current = loaded?.path === resolved ? loaded : null;
  const html = useLocalAssets(current?.html, resolved)?.html ?? null;
  const srcDoc = useMemo(() => (html === null ? undefined : previewDocument(html, dark)), [html, dark]);
  const label = title || (path ? basename(path) : 'Visualization');
  const menu = useFileMenu(resolved);
  return (
    <span className={`md-visualization${mode === 'wide' ? ' wide' : ''}${expanded ? ' expanded' : ''}`}>
      <span className="md-visualization-header">
        <span>{label}</span>
        <span className="md-visualization-actions">
          {srcDoc && (
            <button type="button" onClick={() => setExpanded((value) => !value)} aria-expanded={expanded}>
              {expanded ? 'Collapse' : 'Expand'}
            </button>
          )}
          {isAbsolutePath(resolved) && /\.html?$/i.test(resolved) && (
            // no room for a menu button of its own: the path's menu opens on a right-click or the keyboard here
            <button type="button" onClick={() => openPath(resolved)} title={resolved} {...menu.target}>
              Open file
            </button>
          )}
        </span>
      </span>
      {menu.menu}
      <VisualizationContent srcDoc={srcDoc} title={label} status={current?.error || 'Loading preview…'} />
    </span>
  );
}

/** Keep the executable frame and its loading/error fallback behind one render boundary. */
export function VisualizationContent({ srcDoc, title, status }: { srcDoc?: string; title: string; status: string }) {
  return srcDoc ? (
    <iframe title={title} sandbox="allow-scripts" referrerPolicy="no-referrer" srcDoc={srcDoc} />
  ) : (
    <span className="md-visualization-status" role="status">
      {status}
    </span>
  );
}
