// The project chooser for new chats: search, the project list, a new project and projectless chats.

import { useEffect, useRef, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useStore } from '../../store/core';
import { selectLocalProject } from '../../store/localProjectDraft';
import { createProject, setNewChatHostFolder } from '../../store/projects';
import { native } from '../../lib/native';
import { basename } from '../../lib/paths';
import { Popover, type Placement } from '../ui/Popover';
import { Search, Folder, Plus, X, Check, Laptop } from '../ui/icons';
import { HostFolderPicker } from './HostFolderPicker';
import { useHostAccess } from '../../lib/host';
import { useHostMachines } from '../../lib/hostMachines';
import { MenuRow, useListbox } from '../ui/MenuList';
import { draftTarget } from '../sidebar/homeTarget';

/** Project chooser used by the new-chat hero and context bar (search, list, new project, projectless). */
export function ProjectMenu({
  anchor,
  open,
  onClose,
  placement = 'top-start',
}: {
  anchor: HTMLElement | null;
  open: boolean;
  onClose: () => void;
  placement?: Placement;
}) {
  const projects = useStore((s) => s.savedProjects);
  const projectless = useStore((s) => s.newChatProjectId === 'none');
  const target = useStore(useShallow((s) => (open ? draftTarget(s) : null)));
  const projectId = target?.kind === 'project' ? target.id : null;
  const hostId = target?.kind === 'machine' && target.path ? target.id : null;
  const [q, setQ] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  // Host (closed alpha): the machines that are online can be browsed for the folder
  const hostAllowed = useHostAccess();
  const machines = useHostMachines().machines.filter((m) => m.status === 'online');
  const [browsing, setBrowsing] = useState<{ id: string; name: string; scope?: string } | null>(null);

  const list = projects.filter(
    (p) => !q || p.name.toLowerCase().includes(q.toLowerCase()) || p.roots[0]?.path.toLowerCase().includes(q.toLowerCase()),
  );
  const choose = (id: string | 'none') => {
    selectLocalProject(id);
    onClose();
  };
  const box = useListbox(list.length, (i) => choose(list[i].id));
  const { setIndex } = box;
  useEffect(() => {
    if (open) {
      setQ('');
      setIndex(0);
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [open, setIndex]);
  const addNew = async () => {
    onClose();
    const p = await native.dialog.openFolder();
    if (!p) return;
    const id = await createProject(p);
    if (id) selectLocalProject(id);
  };

  return (
    <>
      <Popover anchor={anchor} open={open} onClose={onClose} placement={placement}>
        <div className="menu project-menu" style={{ width: 290 }}>
          <div className="menu-search">
            <Search size={15} strokeWidth={1.7} />
            <input
              ref={inputRef}
              placeholder="Search projects"
              aria-label="Search projects"
              value={q}
              onChange={(e) => {
                setQ(e.target.value);
                setIndex(0);
              }}
              {...box.field}
            />
          </div>
          <div className="menu-sep" />
          <div className="menu-scroll" id={box.listId} role="listbox" aria-label="Projects">
            {list.map((p, i) => {
              const folder = basename(p.roots[0]?.path ?? '');
              const checked = projectId === p.id;
              return (
                <MenuRow
                  key={p.id}
                  className={i === box.index ? 'kbd-active' : ''}
                  {...box.option(i)}
                  aria-selected={checked}
                  onClick={() => choose(p.id)}
                >
                  <span className="menu-icon">
                    <Folder size={16} strokeWidth={1.7} />
                  </span>
                  <span className="menu-label">
                    <span className="menu-title">
                      {p.name}
                      {folder && folder !== p.name && <span className="menu-inline-desc"> {folder}</span>}
                    </span>
                  </span>
                  <span className="menu-check">{checked ? <Check size={15} strokeWidth={2} /> : null}</span>
                </MenuRow>
              );
            })}
            {list.length === 0 && <div className="menu-empty">No projects</div>}
          </div>
          <div className="menu-sep" />
          {/* actions after the list: Tab reaches them from the search field */}
          <button type="button" className="menu-item" onClick={addNew}>
            <span className="menu-icon">
              <Plus size={16} strokeWidth={1.7} />
            </span>
            <span className="menu-label">New project</span>
          </button>
          {hostAllowed &&
            machines.map((m) => {
              const checked = m.id === hostId;
              return (
                <button
                  key={m.id}
                  type="button"
                  className="menu-item"
                  aria-current={checked}
                  onClick={() => {
                    onClose();
                    setBrowsing({ id: m.id, name: m.name, scope: m.repositoryScope });
                  }}
                >
                  <span className="menu-icon">
                    <Laptop size={16} strokeWidth={1.7} />
                  </span>
                  <span className="menu-label">Folder on {m.name}…</span>
                  <span className="menu-check">{checked ? <Check size={15} strokeWidth={2} /> : null}</span>
                </button>
              );
            })}
          <button type="button" className="menu-item" aria-pressed={projectless} onClick={() => choose('none')}>
            <span className="menu-icon">
              <X size={16} strokeWidth={1.7} />
            </span>
            <span className="menu-label">Don't work in a project</span>
            <span className="menu-check">{projectless ? <Check size={15} strokeWidth={2} /> : null}</span>
          </button>
        </div>
      </Popover>
      {browsing && (
        <HostFolderPicker
          hostId={browsing.id}
          name={browsing.name}
          onClose={() => setBrowsing(null)}
          onPick={(path) => {
            setNewChatHostFolder(browsing, path);
            setBrowsing(null);
          }}
        />
      )}
    </>
  );
}
