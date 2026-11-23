// Open in, drawn: which apps are installed, each one's icon, and a menu item per app.

import { useEffect, useState } from 'react';
import { native } from '../../lib/native';
import { ignoring } from '../../lib/ignored';
import { openInApp, showInFinder } from '../../session/open';
import { useStore } from '../../store/core';
import { availableOpenApps } from '../../lib/openApps';
import { MenuItem } from '../ui/Popover';
import { folderOnMachine, onMachineHint } from '../../lib/machineFolder';

// the last answer: a menu that mounts on each open starts from it instead of offering every app again
let lastInstalled: Record<string, boolean> | null = null;
/** Which apps are installed, read again on each mount; null until the first answer, or when no list can be read. */
export function useInstalledApps(): Record<string, boolean> | null {
  const [installed, setInstalled] = useState(lastInstalled);
  useEffect(() => {
    let live = true;
    // optional: unanswered, the last list (or every app) is offered
    native.app.installed().then((r) => {
      lastInstalled = r;
      if (live) setInstalled(r);
    }, ignoring('list the installed apps for Open in'));
    return () => {
      live = false;
    };
  }, []);
  return installed;
}

const iconCache: Record<string, string | null> = {};
/** The app's own icon, once it is read; nothing without one. */
export function AppIcon({ id }: { id: string }) {
  const [src, setSrc] = useState(iconCache[id] ?? null);
  useEffect(() => {
    if (id in iconCache) return setSrc(iconCache[id]);
    let live = true;
    // an icon is cosmetic: without one the name shows alone, and the next pick asks again
    native.app.icon(id).then((u) => {
      iconCache[id] = u;
      if (live) setSrc(u);
    }, ignoring("read an app's icon"));
    return () => {
      live = false;
    };
  }, [id]);
  return src ? <img className="app-icon-16" src={src} alt="" /> : null;
}

/**
 * One menu item per installed app that opens `path` in it, the preferred app (Settings → General) first; none for no folder. A chat's folder on a machine opens in nothing here: one greyed item says where the folder is, so the menu reads the same for every chat.
 */
export function OpenInItems({ path, machine = null }: { path: string; machine?: { name: string } | null }) {
  const preferred = useStore((s) => s.prefs.openDestination);
  const apps = availableOpenApps(useInstalledApps(), preferred);
  const ordered = apps.toSorted((a, b) => Number(b.value === preferred) - Number(a.value === preferred));
  if (machine)
    return (
      <MenuItem disabled hint={onMachineHint(machine.name)} title={folderOnMachine(machine.name)}>
        Open folder
      </MenuItem>
    );
  if (!path) return null;
  return (
    <>
      {ordered.map((o) => (
        <MenuItem
          key={o.value}
          icon={<AppIcon id={o.value} />}
          onSelect={() => (o.value === 'finder' ? showInFinder(path) : openInApp(o.value, path))}
        >
          {o.label}
        </MenuItem>
      ))}
    </>
  );
}
