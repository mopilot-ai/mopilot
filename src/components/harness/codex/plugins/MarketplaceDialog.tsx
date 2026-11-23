// Marketplace source, git ref and sparse-path submission dialog.
import { useEffect, useState } from 'react';
import { codexRequest } from '../../../../harness/adapters/codex';
import { toast } from '../../../../store/core';
import { errorText } from '../../../../lib/ignored';
import { WebLink } from '../../../ui/WebLink';
import { X } from '../../../ui/icons';
import type { MarketplaceAddResponse } from '../../../../protocol/v2/MarketplaceAddResponse';
import { loadPlugins } from './catalog';
import { imeComposing } from '../../../../lib/focus';

/** "Add → Add a marketplace": the official source / git ref / sparse paths form. */
export function MarketplaceDialog({ onClose }: { onClose: () => void }) {
  const [source, setSource] = useState('');
  const [ref, setRef] = useState('');
  const [sparse, setSparse] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    const h = (e: KeyboardEvent) => e.key === 'Escape' && !imeComposing(e) && onClose();
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [onClose]);
  const submit = async () => {
    if (!source.trim() || busy) return;
    setBusy(true);
    try {
      const paths = sparse
        .split(/\n|,/)
        .map((x) => x.trim())
        .filter(Boolean);
      const r = await codexRequest<MarketplaceAddResponse>('marketplace/add', {
        source: source.trim(),
        refName: ref.trim() || null,
        sparsePaths: paths.length ? paths : null,
      });
      await loadPlugins(true);
      toast(r.alreadyAdded ? `${r.marketplaceName} is already added` : `Added ${r.marketplaceName}`);
      onClose();
    } catch (e) {
      toast(errorText(e), 'error');
    }
    setBusy(false);
  };
  return (
    <div className="sketch-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <form
        className="mk-dialog"
        role="dialog"
        aria-label="Add plugin marketplace"
        onSubmit={(e) => {
          e.preventDefault();
          // cannot reject: submit says itself why the marketplace wasn't added
          void submit();
        }}
      >
        <button type="button" className="mk-close" onClick={onClose} aria-label="Close dialog">
          <X size={16} />
        </button>
        <div className="mk-title">Add plugin marketplace</div>
        <div className="mk-sub">
          Add from a GitHub repo, Git URL, or local folder. <WebLink href="https://developers.openai.com/codex/plugins">Learn more</WebLink>
        </div>
        <label className="mk-field">
          Source
          <input
            autoFocus
            value={source}
            onChange={(e) => setSource(e.target.value)}
            placeholder="openai/plugins or git@github.com:org/repo.git"
            spellCheck={false}
          />
        </label>
        <label className="mk-field">
          Git ref
          <input value={ref} onChange={(e) => setRef(e.target.value)} placeholder="main" spellCheck={false} />
        </label>
        <label className="mk-field">
          Sparse paths
          <textarea value={sparse} onChange={(e) => setSparse(e.target.value)} placeholder="plugins/codex" spellCheck={false} />
        </label>
        <div className="mk-foot">
          <button type="button" className="mk-btn" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="mk-btn primary" disabled={!source.trim() || busy}>
            Add marketplace
          </button>
        </div>
      </form>
    </div>
  );
}
