// The sidebar's project sections (grouping, naming inline, the Section submenu) and the Projects header options menu.
import { useStore, set as setState, setPrefs } from '../../store/core';
import { useHostAccess } from '../../lib/host';
import { Menu, MenuItem, MenuSeparator, SubMenu, Tooltip, useAnchor } from '../ui/Popover';
import { ArrowUpDown, LayoutList, Rows3, Ellipsis, X } from '../ui/icons';
import type { AppState } from '../../store/state';
import { DEFAULT_PREFS } from '../../store/types';
import { cancelOnEscape, isEnter } from '../../lib/focus';

export const EMPTY_SECTIONS: { id: string; name: string }[] = [];
export const EMPTY_MAP: Record<string, string> = {};

/** Projects grouped under user sections (unsectioned first), as in the official sidebar. */
export function sectionedGroups<T extends { id: string | null }>(
  groups: T[],
  sections: { id: string; name: string }[],
  map: Record<string, string>,
) {
  const out: { section: { id: string; name: string } | null; items: T[] }[] = [
    { section: null, items: groups.filter((g) => !g.id || !map[g.id] || !sections.some((x) => x.id === map[g.id!])) },
  ];
  for (const sec of sections) out.push({ section: sec, items: groups.filter((g) => g.id && map[g.id] === sec.id) });
  return out.filter((x) => x.section || x.items.length);
}

/** "Section ›" submenu of a project: move it into a sidebar section or create one. */
export function SectionSubmenu({ projectId }: { projectId: string }) {
  const sections = useStore((s) => s.prefs.sidebarSections ?? EMPTY_SECTIONS);
  const map = useStore((s) => s.prefs.projectSection ?? EMPTY_MAP);
  const assign = (id: string | null) => {
    const next = { ...map };
    if (id) next[projectId] = id;
    else delete next[projectId];
    setPrefs({ projectSection: next });
  };
  return (
    <SubMenu icon={<Rows3 size={15} />} label="Section">
      {sections.map((sec) => (
        <MenuItem key={sec.id} checked={map[projectId] === sec.id} onSelect={() => assign(map[projectId] === sec.id ? null : sec.id)}>
          {sec.name}
        </MenuItem>
      ))}
      {sections.length > 0 && <MenuSeparator />}
      <MenuItem
        onSelect={() => {
          // Electron has no window.prompt; name the section inline in the sidebar instead.
          const id = Math.random().toString(36).slice(2, 8);
          setPrefs({ sidebarSections: [...sections, { id, name: 'New section' }], projectSection: { ...map, [projectId]: id } });
          setState({ renamingSection: id } as SectionRename);
        }}
      >
        New section…
      </MenuItem>
    </SubMenu>
  );
}

/** The section being named inline; transient UI state kept outside AppState's declared fields. */
type SectionRename = Partial<AppState> & { renamingSection?: string | null };

export function SectionLabel({ section, sections }: { section: { id: string; name: string }; sections: { id: string; name: string }[] }) {
  const renaming = useStore((s) => (s as AppState & SectionRename).renamingSection === section.id);
  const map = useStore((s) => s.prefs.projectSection ?? EMPTY_MAP);
  const commit = (v: string) => {
    setState({ renamingSection: null } as SectionRename);
    if (v.trim()) setPrefs({ sidebarSections: sections.map((x) => (x.id === section.id ? { ...x, name: v.trim() } : x)) });
  };
  if (renaming)
    return (
      <input
        className="rename-input side-section-input"
        autoFocus
        defaultValue={section.name}
        onFocus={(e) => e.currentTarget.select()}
        onBlur={(e) => commit(e.currentTarget.value)}
        onKeyDown={(e) => {
          if (isEnter(e)) e.currentTarget.blur();
          cancelOnEscape(e, () => setState({ renamingSection: null } as SectionRename));
        }}
      />
    );
  return (
    <div className="side-section-label" onDoubleClick={() => setState({ renamingSection: section.id } as SectionRename)}>
      <span>{section.name}</span>
      <Tooltip label="Remove section">
        <button
          className="icon-btn xs"
          aria-label="Remove section"
          onClick={() => {
            const next = { ...map };
            for (const k of Object.keys(next)) if (next[k] === section.id) delete next[k];
            setPrefs({ sidebarSections: sections.filter((x) => x.id !== section.id), projectSection: next });
          }}
        >
          <X size={12} />
        </button>
      </Tooltip>
    </div>
  );
}

/** Projects header: independent controls for stable project placement and chat recency. */
export function SidebarOptions() {
  const m = useAnchor();
  const organize = useStore((s) => s.prefs.sidebarOrganize ?? 'project');
  // the machine view needs Host: without it the item is not offered
  const hostOn = useHostAccess();
  const sort = useStore((s) => s.prefs.chatSort ?? 'updated');
  const projectSort = useStore((s) => s.prefs.projectSort ?? DEFAULT_PREFS.projectSort);
  const showHarness = useStore((s) => s.prefs.showChatHarness ?? false);
  return (
    <>
      <Tooltip label="Project sidebar options">
        <button ref={m.ref} className="icon-btn sm" onClick={m.toggle} aria-label="Project sidebar options">
          <Ellipsis size={14} strokeWidth={1.7} />
        </button>
      </Tooltip>
      <Menu anchor={m.anchor} open={m.open} onClose={m.close} placement="bottom-start" width={220}>
        <SubMenu icon={<LayoutList size={15} />} label="Organize sidebar">
          <MenuItem checked={organize === 'project'} onSelect={() => setPrefs({ sidebarOrganize: 'project' })}>
            By project
          </MenuItem>
          <MenuItem checked={organize === 'list'} onSelect={() => setPrefs({ sidebarOrganize: 'list' })}>
            In one list
          </MenuItem>
          {hostOn && (
            <MenuItem checked={organize === 'machine'} onSelect={() => setPrefs({ sidebarOrganize: 'machine' })}>
              By machine
            </MenuItem>
          )}
        </SubMenu>
        <SubMenu icon={<ArrowUpDown size={15} />} label="Project order">
          <MenuItem checked={projectSort === 'custom'} onSelect={() => setPrefs({ projectSort: 'custom' })}>
            Custom
          </MenuItem>
          <MenuItem checked={projectSort === 'updated'} onSelect={() => setPrefs({ projectSort: 'updated' })}>
            Recent activity
          </MenuItem>
          <MenuItem checked={projectSort === 'name'} onSelect={() => setPrefs({ projectSort: 'name' })}>
            Name
          </MenuItem>
        </SubMenu>
        <SubMenu icon={<ArrowUpDown size={15} />} label="Chat order">
          <MenuItem checked={sort === 'updated'} onSelect={() => setPrefs({ chatSort: 'updated' })}>
            Last updated
          </MenuItem>
          <MenuItem checked={sort === 'manual'} onSelect={() => setPrefs({ chatSort: 'manual' })}>
            Manual order
          </MenuItem>
        </SubMenu>
        <MenuSeparator />
        <MenuItem checked={showHarness} onSelect={() => setPrefs({ showChatHarness: !showHarness })}>
          Show harness icons
        </MenuItem>
      </Menu>
    </>
  );
}
