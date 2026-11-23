// The permission menu of a Claude Code or Codex chat on a machine: the modes that machine's Host takes, sent with the chat's next message (electron/host/remoteSend.cjs).
import { useEffect } from 'react';
import { ownsComposerCommand } from '../../lib/shortcutFocus';
import { permissionMenu } from '../../harness/permissionsMenu';
import type { HarnessId } from '../../harness/types';
import { useHostPermission } from './useHostPermission';
import { permissionIcon } from '../harnessPicker/permissionIcon';
import { set, toast, useStore } from '../../store/core';
import { setChatConfig } from '../../store/projects';
import { useHostMachines } from '../../lib/hostMachines';
import { hostModelSelection } from '../../../shared/host/models.mjs';
import { Check } from '../ui/icons';
import { MenuList, MenuRow } from '../ui/MenuList';
import { Popover, Tooltip, useAnchor } from '../ui/Popover';
import { WebLink } from '../ui/WebLink';

/** The line This Mac's menu gives for a model that cannot auto-approve. */
const NO_AUTO = "This model can't auto-approve · Switch model";

export function HostPermissionPicker({ threadId, family, hostId }: { threadId: string | null; family: HarnessId; hostId: string }) {
  const picked = useStore((s) => (threadId ? s.chatConfig[threadId]?.hostSelection : s.newChatHost?.selection));
  const { machines } = useHostMachines();
  // "Approve for me" only where the machine's selected model can auto-approve (as on this Mac); a Host that does not say gates nothing
  const models = machines.find((m) => m.id === hostId)?.agents.find((x) => x.id === family)?.models ?? [];
  const noAuto = hostModelSelection(models, picked, hostId, family).model?.supportsAutoMode === false;
  const a = useAnchor();
  useEffect(() => {
    const h = (event: Event) => {
      if (ownsComposerCommand(event, a.anchor)) a.setOpen(true);
    };
    window.addEventListener('open-permission-picker', h);
    return () => window.removeEventListener('open-permission-picker', h);
  }, [a]);
  const menu = permissionMenu(family);
  const rows = menu.rows;
  const mode = useHostPermission(threadId, family, hostId);
  // Normalization above restricts mode to the four anchors every first-tier menu contains.
  const cur = rows.find((p) => p.id === mode)!;
  return (
    <>
      <Tooltip label="Change permissions">
        <button ref={a.ref} className={`perm-btn ${cur.id} ${a.open ? 'active' : ''}`} onClick={a.toggle} aria-label="Change permissions">
          {permissionIcon(cur.id, 15)}
          <span>{cur.label}</span>
        </button>
      </Tooltip>
      <Popover anchor={a.anchor} open={a.open} onClose={a.close} placement="top-start">
        <div className="menu perm-menu" style={{ width: 460 }}>
          <div className="perm-menu-head">
            <span>{menu.title}</span>
            <WebLink href={menu.learnMore}>Learn more</WebLink>
          </div>
          <MenuList className="perm-list" label={menu.title}>
            {rows.map((p) => (
              <MenuRow
                key={p.id}
                className={`has-desc perm-item ${p.id} ${noAuto && p.id === 'auto-review' ? 'disabled' : ''}`}
                role="menuitemradio"
                aria-checked={p.id === cur.id}
                // not for this model: the keyboard skips it and a click says why
                aria-disabled={noAuto && p.id === 'auto-review'}
                title={noAuto && p.id === 'auto-review' ? NO_AUTO : undefined}
                onClick={() => {
                  if (noAuto && p.id === 'auto-review') return toast(NO_AUTO);
                  if (threadId) setChatConfig(threadId, { hostPermission: { hostId, harness: family, value: p.id } });
                  else
                    set((s) =>
                      s.newChatHost?.id === hostId
                        ? { newChatHost: { ...s.newChatHost, permission: { hostId, harness: family, value: p.id } } }
                        : {},
                    );
                  a.close();
                }}
              >
                <span className="menu-icon">{permissionIcon(p.id, 18)}</span>
                <span className="menu-label">
                  <span className="menu-title">{p.label}</span>
                  <span className="menu-desc">{p.detail}</span>
                </span>
                <span className="menu-check">{p.id === cur.id ? <Check size={16} strokeWidth={2} /> : null}</span>
              </MenuRow>
            ))}
          </MenuList>
          <p className="perm-mode-note">Applies from the next message. The message waits if the Host cannot set this mode.</p>
        </div>
      </Popover>
    </>
  );
}
