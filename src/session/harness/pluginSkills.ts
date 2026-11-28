// The / menu's plugin skills and commands for a harness family that doesn't load plugins itself (the basic tier):
// read from MoPilot's plugin store, and read again whenever its installs change.
import { useEffect, useState } from 'react';
import { native } from '../../lib/native';
import type { PluginFamily, PluginSkill } from '../../lib/native/plugins';
import { componentReach } from '../../../shared/plugins/reach.mjs';
import type { HarnessFamily } from '../../harness/family';

/** Whether MoPilot provides plugin skills to this family (shared/plugins/reach.mjs), rather than the harness. */
export const providesPluginSkills = (family: HarnessFamily) => componentReach({ kind: 'skills', name: '' }, family).reach === 'mopilot';

/** The plugin skills and commands to offer in a chat on `family`; none where the harness loads plugins itself. */
export function usePluginSkills(family: HarnessFamily | null): PluginSkill[] {
  const on = family !== null && providesPluginSkills(family);
  const [state, setState] = useState<{ family: HarnessFamily | null; skills: PluginSkill[] }>({ family, skills: [] });
  useEffect(() => {
    if (!on) return;
    let alive = true;
    let generation = 0;
    const load = () => {
      const current = ++generation;
      return native.plugins.skillsFor(family as PluginFamily).then(
        (skills) => alive && current === generation && setState({ family, skills }),
        // a store that can't be read offers none; the Plugins page says why
        () => alive && current === generation && setState({ family, skills: [] }),
      );
    };
    load();
    const off = native.plugins.onChanged(load);
    return () => {
      alive = false;
      off();
    };
  }, [family, on]);
  // another family's list never shows, from the first frame
  return on && state.family === family ? state.skills : [];
}

/** Plugin slash entries share the same attachment action and refresh ownership. */
export function usePluginSlashItems(family: HarnessFamily | null) {
  return usePluginSkills(family).map((k) => ({
    id: `plugin-skill:${k.name}`,
    title: `/${k.name}`,
    desc: k.description,
    scope: 'Plugin',
    skill: true,
    skillAttachment: { name: k.name, path: k.file },
  }));
}
