// Review-page navigation and view selection; shared search state and detail views have dedicated modules.

import { useEffectOn } from '../../lib/effects';
import { toast } from '../../store/core';
import { projectForThread } from '../../store/projects';
import { errorText } from '../../lib/ignored';
import { relativeTime } from '../../lib/format';
import { Menu, MenuItem, MenuSeparator, Tooltip, useAnchor } from '../ui/Popover';
import { Search, Ellipsis, FileDiff, RefreshCw } from '../ui/icons';
import { isEnter } from '../../lib/focus';

import { useReview, gh, FIELDS, loadLists, type PR } from './review/state';
import { PRView } from './review/PullRequestView';
import { LocalReview } from './review/LocalReview';
export { noChecksReported } from './review/PullRequestView';

export function ReviewNav() {
  const { lists, selected, error, teamError, query } = useReview();
  const menu = useAnchor();
  // the first time the page opens: the lists stay loaded (Refresh reads them again) when it opens again
  useEffectOn([], () => {
    // cannot reject: loadLists shows a failed search as the page's error
    if (lists.mine === null) void loadLists();
  });
  const openFromQuery = async () => {
    const m = /github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)/.exec(query) ?? /^#?(\d+)$/.exec(query.trim());
    if (!m) return;
    try {
      const args =
        m.length === 3
          ? ['pr', 'view', m[2], '--repo', m[1], '--json', FIELDS.replace(',repository', '') + ',headRepository']
          : ['pr', 'view', m[1], '--json', FIELDS.replace(',repository', '')];
      const pr = JSON.parse(await gh(args));
      useReview.setState({
        selected: { ...pr, repository: { nameWithOwner: m.length === 3 ? m[1] : '', name: m.length === 3 ? m[1].split('/')[1] : '' } },
      });
    } catch (e) {
      toast(errorText(e), 'error');
    }
  };
  const filt = (l: PR[] | null) =>
    (l ?? []).filter((p) => !query || p.title.toLowerCase().includes(query.toLowerCase()) || String(p.number).includes(query));
  const section = (title: string, list: PR[] | null, failed: string | null = null) => (
    <div className="sidebar-section" key={title}>
      <div className="side-label">{title}</div>
      {failed && (
        <div className="side-row empty-note recents" role="alert">
          Couldn't search: {failed}
        </div>
      )}
      {list === null &&
        [0, 1, 2, 3].map((i) => (
          <div key={i} className="skeleton-row">
            <span className="sk a" />
            <span className="sk b" />
          </div>
        ))}
      {list && !failed && filt(list).length === 0 && <div className="side-row empty-note recents">None</div>}
      {filt(list).map((p) => (
        <button
          key={p.url}
          className={`review-pr-row ${selected?.url === p.url ? 'selected' : ''}`}
          onClick={() => useReview.setState({ selected: p })}
        >
          <span className="review-pr-title">{p.title}</span>
          <span className="review-pr-meta">
            {p.repository.name} #{p.number} · {relativeTime(Date.parse(p.updatedAt) / 1000)}
            {p.isDraft ? ' · Draft' : ''}
          </span>
        </button>
      ))}
    </div>
  );
  return (
    <aside className="sidebar">
      <div className="sidebar-header">
        <span className="sidebar-title static">Code Review</span>
        <div className="sidebar-header-actions">
          <button ref={menu.ref} className="icon-btn" onClick={menu.toggle} aria-label="Code review options">
            <Ellipsis size={16} />
          </button>
        </div>
      </div>
      <div className="settings-search small">
        <Search size={14} strokeWidth={1.7} />
        <input
          placeholder="Search or paste a PR link"
          value={query}
          onChange={(e) => useReview.setState({ query: e.target.value })}
          onKeyDown={(e) => isEnter(e) && openFromQuery()}
        />
      </div>
      <div className="sidebar-scroll">
        {error && <div className="side-row empty-note recents">{error}</div>}
        {section('Authored by me', lists.mine)}
        {section('Needs my review', lists.review)}
        {section("Needs my team's review", lists.team, teamError)}
      </div>
      <Menu anchor={menu.anchor} open={menu.open} onClose={menu.close} placement="bottom-end" width={230}>
        <MenuItem icon={<RefreshCw size={15} />} onSelect={loadLists}>
          Refresh
        </MenuItem>
        <MenuItem icon={<FileDiff size={15} />} onSelect={() => useReview.setState({ selected: null })}>
          Review local changes
        </MenuItem>
      </Menu>
    </aside>
  );
}

export function Review() {
  const selected = useReview((s) => s.selected);
  return <div className="page review-page">{selected ? <PRView key={selected.url} pr={selected} /> : <LocalReview />}</div>;
}

export { projectForThread, MenuSeparator, Tooltip };
