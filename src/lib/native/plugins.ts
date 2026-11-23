// window.native.plugins' types (MoPilot's own plugin store, delivered to every harness), merged into NativeApi; the calls are declared in electron/bridge/plugins.cjs.
import type { BuiltinConnector } from './contracts/builtinConnectors';
import type { PluginSpec } from '../../../shared/plugins/manifest.mjs';
import type { Marketplace, MarketplaceSource } from '../../../shared/plugins/marketplace.mjs';

/** The harness families a plugin can be turned off for one by one. */
export type PluginFamily = 'codex' | 'claude' | 'acp';

/** One installed plugin: its record in installed.json and what its folder holds (null, with `error`, when unreadable). */
export type InstalledPlugin = {
  id: string;
  path: string;
  version?: string;
  enabled: boolean;
  harnesses: Partial<Record<PluginFamily, boolean>>;
  trusted: string;
  origin?: string;
  installedAt: number;
  updatedAt: number;
  spec: PluginSpec | null;
  error: string | null;
};

export type MarketplaceListing = {
  name: string;
  source: MarketplaceSource;
  updatedAt?: number;
  marketplace: Marketplace | null;
  error: string | null;
};

/** A plugin skill or command MoPilot provides: named "<plugin>@<marketplace>:<kind>:<skill>", with the file it is read from. */
export type PluginSkill = { name: string; kind: 'skill' | 'command'; description?: string; file: string };

/** A plugin Claude Code or Codex installed itself, outside MoPilot's store. */
export type NativePlugin = { id: string; name: string; marketplace: string; path: string; harness: 'claude' | 'codex' };

/** What the Codex mirror did with a store plugin (electron/plugins/codexMirror.cjs). */
export type CodexMirrorState = {
  codexId: string;
  path: string;
  state: 'installed' | 'alreadyOn' | 'failed' | 'removeFailed';
  error?: string;
};

/** What installing a plugin would bring, what it lets run, and the digest the install must be given back. */
export type PluginPreview = { ok: true; spec: PluginSpec; runs: string[]; trust: string } | { ok: false; error: string };

declare module '../native' {
  interface NativeApi {
    plugins: {
      /** every installed plugin; `error` when the installed list itself couldn't be read */
      list(): Promise<{ plugins: InstalledPlugin[]; error: string | null }>;
      catalog(): Promise<{ marketplaces: MarketplaceListing[]; error: string | null }>;
      preview(marketplace: string, name: string): Promise<PluginPreview>;
      /** rejects when what the plugin runs changed since the preview whose `trust` is given */
      install(marketplace: string, name: string, trust: string): Promise<{ id: string }>;
      uninstall(id: string): Promise<boolean>;
      /** on or off everywhere, or for one harness family */
      setEnabled(id: string, enabled: boolean, family?: PluginFamily): Promise<unknown>;
      /** a folder, owner/repo or git URL (optionally #ref): resolves to the marketplace's name */
      marketplaceAdd(source: string): Promise<string>;
      marketplaceUpgrade(name: string): Promise<boolean>;
      marketplaceRemove(name: string): Promise<boolean>;
      /** the plugin skills and commands MoPilot provides to a harness family that doesn't load them itself */
      skillsFor(family: PluginFamily): Promise<PluginSkill[]>;
      /** the plugins Claude Code and Codex installed themselves */
      native(): Promise<NativePlugin[]>;
      /** what copying one into the store would bring and run */
      previewNative(id: string): Promise<PluginPreview>;
      /** copy it into the store under the reviewed trust, so every harness gets it */
      importNative(id: string, trust: string): Promise<{ id: string }>;
      /** by store id, what the Codex mirror did */
      codexStates(): Promise<Record<string, CodexMirrorState>>;
      /** the optional built-in connectors (GitHub); on downloads (first time, checksum-verified) and installs for every harness, and rejects with why it couldn't */
      builtin: { list(): Promise<BuiltinConnector[]>; set(id: string, on: boolean): Promise<BuiltinConnector[]> };
      onChanged(cb: (e: { ids?: string[]; marketplaces?: boolean }) => void): () => void;
    };
  }
}
