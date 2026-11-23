// ACP composer modes and permissions share one current-state trigger and a complete, grouped selection menu.
import { useEffect, useMemo } from 'react';
import { useStore } from '../../store/core';
import { useSessionField } from '../../store/session/useSession';
import { basicLabel } from '../../session/harness/acp';
import { chooseBasicMode, splitModes, useBasicSelection, type BasicSelection, type ModeRow } from '../../session/acpControls';
import { copy } from '../../harness/copy';
import { Popover, Tooltip, useAnchor } from '../ui/Popover';
import { MenuList, MenuRow } from '../ui/MenuList';
import { Bot, Check, ChevronDown, Hand } from '../ui/icons';
import { permissionIcon } from './permissionIcon';
import { ownsComposerCommand } from '../../lib/shortcutFocus';

export function ModePicker({ threadId, id }: { threadId: string | null; id: string }) {
  const sel = useBasicSelection(threadId, id);
  const entry = useStore((s) => s.basicHarnesses.find((h) => h.id === id));
  const { permissionModes, agentModes } = entry ?? {};
  const split = useMemo(
    () => (sel.mode ? splitModes(sel.mode, permissionModes, agentModes) : null),
    [sel.mode, permissionModes, agentModes],
  );
  const permission = split?.permission ?? [];
  const agent = split?.agent ?? [];
  const hasModes = !!(permission.length || agent.length);
  const label = basicLabel(id);
  const pending = useSessionField(threadId, (s) => s.pendingSwitch);
  if (pending || !hasModes) {
    const why = pending
      ? "The session's mode applies when the next message switches."
      : copy('harness', sel.known ? 'permissionsNoModes' : 'permissionsModesUnknown', { label });
    return (
      <Tooltip label={why}>
        <span className="perm-btn set-by acp-permission-info" aria-label="Permissions" aria-description={why} tabIndex={0}>
          <Hand size={15} strokeWidth={1.7} />
        </span>
      </Tooltip>
    );
  }
  // An unavailable or replaced control unmounts its menu, including focus and shortcut ownership.
  return <AvailableModes key={JSON.stringify([threadId, id])} {...{ threadId, id, sel, permission, agent }} />;
}

function AvailableModes({
  threadId,
  id,
  sel,
  permission,
  agent,
}: {
  threadId: string | null;
  id: string;
  sel: BasicSelection;
  permission: ModeRow[];
  agent: ModeRow[];
}) {
  const a = useAnchor();
  useEffect(() => {
    const open = (event: Event) => {
      if (ownsComposerCommand(event, a.anchor)) a.setOpen(true);
    };
    window.addEventListener('open-permission-picker', open);
    return () => window.removeEventListener('open-permission-picker', open);
  }, [a]);
  const label = basicLabel(id);
  const current = sel.mode!.current;
  const cur = [...permission, ...agent].find((r) => r.id === current);
  const name = cur?.label ?? (current || copy('harness', 'agentModeNone'));
  const why = cur?.permission ? cur.label : copy('harness', 'permissionsSetByMode', { mode: name, label });
  const title = `What ${label} can do`;
  const groups = [
    { name: 'Permissions', rows: permission },
    { name: 'Mode', rows: agent },
  ];
  return (
    <>
      <Tooltip label={why}>
        <button
          ref={a.ref}
          className={`perm-btn acp-mode-trigger ${cur?.permission ?? ''} ${a.open ? 'active' : ''}`}
          onClick={a.toggle}
          aria-label={permission.length ? 'Change permissions' : 'Change mode'}
          aria-description={why}
          aria-haspopup="menu"
          aria-expanded={a.open}
        >
          {modeIcon(cur, 15)}
          <span>{name}</span>
          <ChevronDown size={11} strokeWidth={2} />
        </button>
      </Tooltip>
      <Popover anchor={a.anchor} open={a.open} onClose={a.close} placement="top-start">
        <div className="menu perm-menu acp-mode-menu acp-perm-menu" style={{ width: 320 }}>
          <div className="perm-menu-head">
            <span>{title}</span>
          </div>
          {!cur?.permission && current && permission.some((r) => r.permission) && (
            <p className="perm-mode-note">
              {copy('harness', 'permissionsSetByMode', { mode: name, label })}. Choosing a permission preset switches modes.
            </p>
          )}
          <MenuList className="perm-list" label={title}>
            {groups.map(
              (group) =>
                group.rows.length > 0 && (
                  <div key={group.name} role="group" aria-label={group.name}>
                    {permission.length > 0 && agent.length > 0 && <div className="hp-head acp-mode-section">{group.name}</div>}
                    {group.rows.map((r) => (
                      <MenuRow
                        key={r.id}
                        className={`has-desc perm-item ${r.permission ?? ''}`}
                        role="menuitemradio"
                        aria-checked={r.id === current}
                        onClick={() => {
                          a.close();
                          // A refused choice keeps the old mode/default and reports its failure through the shared chooser.
                          void chooseBasicMode(threadId, id, sel, r.id);
                        }}
                      >
                        <span className="menu-icon">{modeIcon(r, 18)}</span>
                        <span className="menu-label">
                          <span className="menu-title">{r.label}</span>
                          {r.detail && <span className="menu-desc">{r.detail}</span>}
                        </span>
                        <span className="menu-check">{r.id === current ? <Check size={16} strokeWidth={2} /> : null}</span>
                      </MenuRow>
                    ))}
                  </div>
                ),
            )}
          </MenuList>
        </div>
      </Popover>
    </>
  );
}

function modeIcon(row: ModeRow | undefined, size: number) {
  return row?.permission ? permissionIcon(row.permission, size) : <Bot size={size} strokeWidth={1.7} />;
}
