// The Projects page: every project with its chat count, newest activity first.

import { selectLocalProject } from '../../store/localProjectDraft';
import { abbreviateHome } from '../../lib/paths';
import { useState } from 'react';
import { onActivate } from '../../lib/focus';
import { navigate } from '../../store/panes';
import { toastFailure } from '../../store/core';
import { createProject } from '../../store/projects';
import { deleteProjectGroup } from '../../session/projectGroupActions';
import { showInFinder } from '../../session/open';
import { native } from '../../lib/native';
import { useProjectGroups } from '../sidebar/Sidebar';
import { Folder, Plus, Search, Ellipsis } from '../ui/icons';
import { Menu, MenuItem, MenuSeparator, useAnchor } from '../ui/Popover';
import { relativeTime } from '../../lib/format';
import type { Thread } from '../../store/types';
import { projectRecency } from '../../lib/projectGroupOrder';

/** Projects: every project with its chat count, newest activity first. */
export function Projects() {
  const { groups } = useProjectGroups();
  const [q, setQ] = useState('');
  const list = groups
    .filter((g) => g.saved && (!q || g.name.toLowerCase().includes(q.toLowerCase())))
    .map((g) => ({ ...g, last: projectRecency(g) }))
    .sort((a, b) => b.last - a.last);
  const add = async () => {
    const p = await native.dialog.openFolder();
    if (p) await createProject(p);
  };
  return (
    <div className="settings-page">
      <div className="settings-inner">
        <div className="projects-head">
          <h1 className="settings-title">Projects</h1>
          <button className="btn-pill" onClick={add}>
            <Plus size={14} /> New project
          </button>
        </div>
        <div className="pill-search wide projects-search">
          <Search size={14} strokeWidth={1.7} />
          <input placeholder="Search projects" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        {list.length === 0 && <div className="empty-state">{q ? 'No matching projects' : 'No projects yet'}</div>}
        {list.length > 0 && (
          <div className="settings-card">
            {list.map((g) => (
              <ProjectRow key={g.id!} g={{ ...g, id: g.id! }} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function ProjectRow({ g }: { g: { id: string; name: string; path: string; threads: Thread[]; last: number; projectIds?: string[] } }) {
  const menu = useAnchor();
  const open = () => {
    selectLocalProject(g.id);
    navigate({ name: 'home', cwd: g.path });
  };
  return (
    // a row, not a <button>: it holds the project's actions button
    <div
      className="settings-row clickable project-row"
      role="button"
      tabIndex={0}
      aria-label={g.name}
      onClick={open}
      onKeyDown={onActivate(open)}
    >
      <Folder size={16} strokeWidth={1.7} className="project-row-icon" />
      <div className="settings-row-text">
        <div className="settings-row-title">{g.name}</div>
        <div className="settings-row-desc">{abbreviateHome(g.path)}</div>
      </div>
      {/* not a control: it keeps its button's clicks (and its menu's, through the portal) off the row */}
      <div className="settings-row-control" role="presentation" onClick={(e) => e.stopPropagation()}>
        <span className="settings-value">
          {g.threads.length} {g.threads.length === 1 ? 'chat' : 'chats'}
          {g.last ? ` · ${relativeTime(g.last)}` : ''}
        </span>
        <button ref={menu.ref} className="icon-btn xs" onClick={menu.toggle} aria-label="Project actions">
          <Ellipsis size={15} />
        </button>
        {/* inside the control: a click in the menu (a portal) bubbles through React here, not to the row */}
        <Menu anchor={menu.anchor} open={menu.open} onClose={menu.close} placement="bottom-end" width={200}>
          <MenuItem onSelect={open}>New chat in project</MenuItem>
          <MenuItem onSelect={() => showInFinder(g.path)}>Open in Finder</MenuItem>
          <MenuSeparator />
          <MenuItem
            danger
            onSelect={() =>
              confirm(`Remove ${g.name} from Projects? Files on disk are not touched.`) &&
              deleteProjectGroup(g.id, g.projectIds).catch(toastFailure("Couldn't remove the project"))
            }
          >
            Remove project
          </MenuItem>
        </Menu>
      </div>
    </div>
  );
}
