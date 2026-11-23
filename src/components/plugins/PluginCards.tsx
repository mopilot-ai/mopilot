// The cards of the shared Plugins page: an installed plugin with one switch, and a plugin to install.
import type { KeyboardEvent, ReactNode } from 'react';
import { native } from '../../lib/native';
import type { InstalledPlugin } from '../../lib/native/plugins';
import { onActivate } from '../../lib/focus';
import { Toggle } from '../pages/Settings';
import { Plus } from '../ui/icons';
import { reachException, type Installs } from './ReachStrip';
import { attempt, openStorePlugin, PluginTile, pluginTitle } from './pluginView';

export function Card({
  tile,
  title,
  desc,
  meta,
  failed,
  onOpen,
  children,
}: {
  tile: ReactNode;
  title: string;
  desc?: string;
  meta?: string;
  failed?: boolean;
  onOpen?: () => void;
  children: ReactNode;
}) {
  return (
    // a card, not a <button>: it holds a switch or a button of its own
    <div
      className={`plugin-card ${onOpen ? 'clickable' : ''}`}
      role={onOpen ? 'button' : undefined}
      tabIndex={onOpen ? 0 : undefined}
      aria-label={onOpen ? title : undefined}
      onClick={onOpen}
      onKeyDown={onOpen && ((e: KeyboardEvent) => e.target === e.currentTarget && onActivate(onOpen)(e))}
    >
      {tile}
      <span className="plugin-card-text">
        <span className="plugin-card-name">{title}</span>
        {desc && <span className="plugin-card-desc">{desc}</span>}
        {meta && <span className={`plugin-card-meta ${failed ? 'failed' : ''}`}>{meta}</span>}
      </span>
      {/* not a control: a press on the switch or button stays off the card */}
      <span className="plugin-card-action" role="presentation" onClick={(e) => e.stopPropagation()}>
        {children}
      </span>
    </div>
  );
}

/** An installed plugin: what differs per harness, if anything, its one switch, and its page on a click. */
export function InstalledCard({
  plugin,
  installs,
  reload,
  onUninstall,
}: {
  plugin: InstalledPlugin;
  installs: Installs;
  reload: () => Promise<void>;
  onUninstall: (plugin: InstalledPlugin, title: string) => void;
}) {
  if (!plugin.spec)
    return (
      <Card tile={<PluginTile />} title={plugin.id} meta={`Can't be read: ${plugin.error}`} failed>
        <button className="btn-pill soft" onClick={() => onUninstall(plugin, plugin.id)}>
          Uninstall
        </button>
      </Card>
    );
  const spec = plugin.spec;
  const title = pluginTitle(spec);
  const exception = reachException({ ...plugin, spec }, installs);
  return (
    <Card
      tile={<PluginTile spec={spec} />}
      title={title}
      desc={spec.description}
      meta={exception?.text ?? (plugin.origin === 'builtin' ? 'Built in' : spec.author && `by ${spec.author}`)}
      failed={exception?.failed}
      onOpen={() => openStorePlugin(plugin.id)}
    >
      {/* a switch stays pending until the store was read again, so a second click flips what it shows */}
      <Toggle
        on={plugin.enabled}
        label={`${title} on or off`}
        onChange={(on) => attempt(() => native.plugins.setEnabled(plugin.id, on)).then(reload)}
      />
    </Card>
  );
}

/** A plugin in an added marketplace, or one a harness installed itself: its review opens from the card or its button. */
export function InstallCard({ title, desc, meta, onInstall }: { title: string; desc?: string; meta: string; onInstall: () => void }) {
  return (
    <Card tile={<PluginTile />} title={title} desc={desc} meta={meta} onOpen={onInstall}>
      <button className="plugin-card-add" aria-label={`Install ${title}`} onClick={onInstall}>
        <Plus size={16} strokeWidth={1.7} />
      </button>
    </Card>
  );
}
