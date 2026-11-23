// Adding a marketplace to MoPilot's plugin store: one of the official sources, or any repo, Git URL or folder.
import { useEffect, useState } from 'react';
import { native } from '../../lib/native';
import type { MarketplaceListing } from '../../lib/native/plugins';
import { toast } from '../../store/core';
import { imeComposing } from '../../lib/focus';
import { X } from '../ui/icons';
import { attempt } from './pluginView';

const OFFICIAL = [
  { source: 'anthropics/claude-plugins-official', title: 'Anthropic plugins' },
  { source: 'openai/plugins', title: 'OpenAI plugins' },
];

export function AddMarketplaceDialog({ added, onClose }: { added: MarketplaceListing[] | null; onClose: () => void }) {
  const [source, setSource] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    const h = (e: KeyboardEvent) => e.key === 'Escape' && !imeComposing(e) && onClose();
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [onClose]);
  const add = async (from: string) => {
    setBusy(true);
    const name = await attempt(() => native.plugins.marketplaceAdd(from));
    setBusy(false);
    if (!name) return;
    toast(`Added ${name}`);
    onClose();
  };
  const offered = OFFICIAL.filter((o) => !added?.some((m) => m.source.kind === 'git' && m.source.url.includes(o.source)));
  return (
    <div className="sketch-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <form
        className="mk-dialog"
        role="dialog"
        aria-label="Add marketplace"
        onSubmit={(e) => {
          e.preventDefault();
          // cannot reject: attempt says itself why the marketplace wasn't added
          if (source.trim()) void add(source.trim());
        }}
      >
        <button type="button" className="mk-close" onClick={onClose} aria-label="Close dialog">
          <X size={16} />
        </button>
        <div className="mk-title">Add marketplace</div>
        {offered.map((o) => (
          <div key={o.source} className="plugin-source">
            <span className="plugin-source-text">
              <span className="plugin-source-title">{o.title}</span>
              <span className="plugin-source-desc">{o.source}</span>
            </span>
            <button
              type="button"
              className="btn-pill soft"
              disabled={busy}
              aria-label={`Add ${o.title}`}
              onClick={() => void add(o.source)}
            >
              Add
            </button>
          </div>
        ))}
        <label className="mk-field">
          Source
          <input
            autoFocus
            aria-label="Marketplace source"
            value={source}
            onChange={(e) => setSource(e.target.value)}
            placeholder="owner/repo, a Git URL or a folder"
            spellCheck={false}
          />
        </label>
        <div className="mk-foot">
          <button type="button" className="mk-btn" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="mk-btn primary" disabled={!source.trim() || busy}>
            {busy ? 'Adding…' : 'Add'}
          </button>
        </div>
      </form>
    </div>
  );
}
