// Settings → Archived chats: list, filter, restore and delete.

import { Row, Select } from './Controls';
import { basename } from '../../../lib/paths';
import { Search, ListFilter, ChevronDown, Trash2, Spinner, Folder } from '../../ui/icons';
import { useEffect, useRef, useState } from 'react';
import { useStore, threadTitle, toast } from '../../../store/core';
import { loadArchived, type ArchivedFailure } from '../../../store/connection';
import { unarchiveThread, deleteThread } from '../../../store/actions';
import { projectForThread } from '../../../store/projects';
import { Menu, MenuItem, useAnchor, Tooltip } from '../../ui/Popover';
import { groupBy } from './Rows';
import { createLatestLoader } from '../../../lib/latestLoader';
import { errorText } from '../../../lib/ignored';
import { momoOwned } from '../../../lib/momoChats';
import { deleteChatQuestion, deleteMachineName } from '../../../lib/deleteChatQuestion';
import { hostAgentOf } from '../../../store/hostAgent';
import { hostOfChatNow } from '../../../lib/hostChats';

/* ------------------------------------------------------------------ */
/* Archived chats                                                      */
/* ------------------------------------------------------------------ */
export function Archived() {
  // MoMo's chats are in no list, however they reached the archive (followArchive, runArchive, loadArchived)
  const archived = useStore((s) => s.archived);
  const initialTitles = useStore((s) => s.chatInitialTitles);
  const momoChats = useStore((s) => s.momoChats);
  const segments = useStore((s) => s.segments);
  const projects = useStore((s) => s.savedProjects);
  const [loading, setLoading] = useState(true);
  // harnesses whose archived chats couldn't be listed: shown with Retry, so the list isn't taken for the whole archive
  const [failures, setFailures] = useState<ArchivedFailure[]>([]);
  const [q, setQ] = useState('');
  const [proj, setProj] = useState('all');
  const [sort, setSort] = useState('updated');
  const loaderRef = useRef<ReturnType<typeof createLatestLoader<ArchivedFailure[]>> | null>(null);
  const load = () => {
    setLoading(true);
    // Retry is rendered only after the mounted loader has completed its first request.
    void loaderRef.current!.load();
  };
  useEffect(() => {
    setLoading(true);
    const loader = createLatestLoader(
      loadArchived,
      (failed) => {
        setFailures(failed);
        setLoading(false);
      },
      (error) => {
        setFailures([{ source: 'chat', error: errorText(error) }]);
        setLoading(false);
      },
    );
    loaderRef.current = loader;
    void loader.load();
    return () => loader.stop();
  }, []);
  if (loading) return <Spinner size={16} />;
  const list = archived
    .filter(
      (t) =>
        !momoOwned(momoChats, segments, t.id) &&
        (!q || threadTitle(t, initialTitles).toLowerCase().includes(q.toLowerCase())) &&
        (proj === 'all' || projectForThread(t, projects)?.id === proj),
    )
    .sort((a, b) =>
      sort === 'alpha'
        ? threadTitle(a, initialTitles).localeCompare(threadTitle(b, initialTitles))
        : sort === 'created'
          ? (b.createdAt ?? 0) - (a.createdAt ?? 0)
          : b.updatedAt - a.updatedAt,
    );
  const groups = groupBy(list, (t) => projectForThread(t, projects)?.name ?? (t.cwd ? basename(t.cwd) : '/'));
  return (
    <>
      <div className="archived-bar">
        <div className="pill-search wide">
          <Search size={14} strokeWidth={1.7} />
          <input placeholder="Search archived chats" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        <ArchivedFilter sort={sort} setSort={setSort} />
        <Select
          value={proj}
          icon={<Folder size={14} />}
          options={[{ value: 'all', label: 'All projects' }, ...projects.map((p) => ({ value: p.id, label: p.name }))]}
          onChange={setProj}
        />
      </div>
      {failures.map((f) => (
        <div key={f.source} className="config-warning" role="alert">
          Couldn't load the archived {f.source} chats: {f.error}{' '}
          <button className="btn-pill soft" onClick={load}>
            Retry
          </button>
        </div>
      ))}
      {list.length === 0 && !failures.length && <div className="empty-state">No archived chats</div>}
      {Object.entries(groups).map(([name, items]) => (
        <section key={name} className="settings-group">
          <div className="archived-group-head">
            <span>
              <Folder size={14} /> {name}
            </span>
            <span>
              {items.length} {items.length === 1 ? 'chat' : 'chats'}
            </span>
          </div>
          <div className="settings-card">
            {items.map((t) => (
              <Row
                key={t.id}
                title={threadTitle(t, initialTitles)}
                desc={new Date(t.updatedAt * 1000).toLocaleString([], {
                  month: 'short',
                  day: 'numeric',
                  year: 'numeric',
                  hour: 'numeric',
                  minute: '2-digit',
                })}
              >
                <button
                  className="btn-pill"
                  onClick={() =>
                    unarchiveThread(t.id).then(
                      () => toast('Chat restored'),
                      (e) => toast(`Couldn't restore chat: ${errorText(e)}`, 'error'),
                    )
                  }
                >
                  Unarchive
                </button>
                <Tooltip label="Delete permanently">
                  <button
                    className="icon-btn xs"
                    onClick={() => {
                      const owner = hostOfChatNow(t.id);
                      if (
                        confirm(
                          deleteChatQuestion(deleteMachineName(t.id, owner ? { name: owner } : null, owner === null), hostAgentOf(t.id)),
                        )
                      )
                        deleteThread(t.id).catch((e) => toast(`Couldn't delete chat: ${errorText(e)}`, 'error'));
                    }}
                  >
                    <Trash2 size={14} />
                  </button>
                </Tooltip>
              </Row>
            ))}
          </div>
        </section>
      ))}
    </>
  );
}

/** Sort archived chats. Every chat in this list is local. */
function ArchivedFilter({ sort, setSort }: { sort: string; setSort: (v: string) => void }) {
  const a = useAnchor();
  const label = sort === 'alpha' ? 'Alphabetical' : sort === 'created' ? 'Created' : 'Updated';
  return (
    <>
      <button ref={a.ref} className="select-btn" onClick={a.toggle}>
        <ListFilter size={14} />
        <span className="select-label">Sort: {label}</span>
        <ChevronDown size={14} strokeWidth={2} />
      </button>
      <Menu anchor={a.anchor} open={a.open} onClose={a.close} placement="bottom-end" width={190}>
        {[
          ['updated', 'Updated'],
          ['created', 'Created'],
          ['alpha', 'Alphabetical'],
        ].map(([v, l]) => (
          <MenuItem key={v} checked={sort === v} onSelect={() => setSort(v)}>
            {l}
          </MenuItem>
        ))}
      </Menu>
    </>
  );
}
