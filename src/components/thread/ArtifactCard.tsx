// The card a Claude Code chat shows when it published or changed a page on claude.ai (an artifact, slides or a Claude Design project): its title and version, with Open (its tab in the side pane) and Copy link.
import { useId } from 'react';
import { AppWindow, Palette } from '../ui/icons';
import { openMessageLink } from '../../session/open';
import { copyText } from '../../session/clipboard';
import type { ArtifactRef } from '../../lib/designToolCall';

// what a page is when its call named no title (the page's own <title> names it on claude.ai)
const TITLE = { artifact: 'Artifact', design: 'Claude Design project' };

export function ArtifactCard({ artifact }: { artifact: ArtifactRef }) {
  const a = artifact;
  const Icon = a.kind === 'design' ? Palette : AppWindow;
  const facts = [a.action === 'created' ? 'Published' : 'Updated', a.version && `version ${a.version}`, 'claude.ai'].filter(Boolean);
  // one page can have several cards (a publish, then another): each labels itself
  const id = useId();
  return (
    <section className="artifact-card" aria-labelledby={id}>
      <span className="artifact-card-icon" aria-hidden="true">
        <Icon size={15} strokeWidth={1.8} />
      </span>
      <span className="artifact-card-name">
        <span id={id} className="artifact-card-title">
          {a.title ?? TITLE[a.kind]}
        </span>
        <span className="artifact-card-sub">{facts.join(' · ')}</span>
      </span>
      <span className="artifact-card-actions">
        <button className="btn-pill" onClick={(e) => openMessageLink(a.url, null, e)}>
          Open
        </button>
        <button className="btn-pill soft" onClick={() => copyText(a.url, 'Copied link')}>
          Copy link
        </button>
      </span>
    </section>
  );
}
