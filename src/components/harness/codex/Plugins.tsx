// Plugins and Customize page routing: every harness's plugins at once (MoPilot's store) or one harness's own catalog.
import { useState } from 'react';
import { useStore } from '../../../store/core';
import { SkillsCatalog } from './SkillsCatalog';
import { CodexNotice } from '../../pages/Login';
import { Segmented } from '../../pages/Settings';
import { PARTS } from '../parts';
import { HARNESS_IDS, HARNESS_LABEL, type HarnessId } from '../../../harness/types';
import { PluginCatalog } from './plugins/PluginCatalog';
import { PluginPage } from './plugins/PluginPage';
import { StorePage } from '../../plugins/StorePage';
import { PluginDetail } from '../../plugins/PluginDetail';
import { STORE_ROUTE } from '../../plugins/pluginView';
import { AllSkills } from '../../skills/AllSkills';
export {
  BUNDLED,
  usePlugins,
  loadPlugins,
  ensurePlugins,
  isPublic,
  nameOf,
  openPlugin,
  toggleInstalled,
  createPlugin,
  type Plugin,
} from './plugins/catalog';
export { PluginLogo } from './plugins/PluginLogo';
export { PluginsNav } from './plugins/PluginsNav';
export { MarketplaceDialog } from './plugins/MarketplaceDialog';

/** A tab of the Plugins page: every harness at once (MoPilot's own store), or one harness's own catalog. */
type View = 'all' | HarnessId;

/**
 * The Plugins and Customize pages. Plugins opens on "All harnesses": MoPilot's store, installed once for every
 * harness (src/components/plugins/StorePage.tsx); a tab per first-class harness keeps that harness's own catalog
 * (Codex's marketplace and app connectors, Claude Code's installed plugins). Skills open on "All harnesses" too (src/components/skills/AllSkills.tsx).
 */
export function Plugins({ tab = 'plugins', plugin, codexOk = true }: { tab?: string; plugin?: string; codexOk?: boolean }) {
  const skills = tab === 'skills';
  // what was picked on each page (Plugins, Skills): moving between them opens each where it was, Plugins on "All"
  const [pickedOn, setPickedOn] = useState<Record<string, View>>({});
  const view: View = pickedOn[tab] ?? 'all';
  const setPicked = (v: View) => setPickedOn((p) => ({ ...p, [tab]: v }));
  const options = [
    { value: 'all' as View, label: 'All harnesses' },
    ...HARNESS_IDS.map((id) => ({ value: id as View, label: HARNESS_LABEL[id] })),
  ];
  const Custom = view === 'all' ? undefined : PARTS[view].Customize;
  return (
    <div className="ext-page">
      {!plugin && (
        <div className="ext-harness-tabs">
          <Segmented value={view} onChange={setPicked} options={options} />
        </div>
      )}
      {plugin?.startsWith(STORE_ROUTE) ? (
        <PluginDetail id={plugin.slice(STORE_ROUTE.length)} />
      ) : view === 'all' && !plugin ? (
        skills ? (
          <AllSkills codexOk={codexOk} />
        ) : (
          <StorePage />
        )
      ) : Custom ? (
        <Custom tab={tab} />
      ) : !codexOk ? (
        <CodexNotice what="The Codex plugin marketplace and skill catalog need Codex." />
      ) : plugin ? (
        <PluginPage id={plugin} />
      ) : skills ? (
        <SkillsCatalog />
      ) : (
        <PluginCatalog />
      )}
    </div>
  );
}
export { useStore };
