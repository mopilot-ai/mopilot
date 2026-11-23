// What the All harnesses Skills view lists: Codex's skills/list, the Claude catalog and the store plugins' skills, each read on its own so one that fails leaves the others shown.
import { useCallback, useEffect, useState } from 'react';
import { createLatestLoader } from '../../lib/latestLoader';
import { native } from '../../lib/native';
import { errorText } from '../../lib/ignored';
import { useStore } from '../../store/core';
import { currentCwdForNewChat } from '../../store/projects';
import { useHarnessStatus } from '../../session/harness/select';
import { HARNESS_LABEL } from '../../harness/types';
import { listCodexSkills } from '../../harness/codexSkills';
import { mergeSkills, type SkillRow } from './mergeSkills';

export interface AllSkillsView {
  /** null until the first read settles */
  rows: SkillRow[] | null;
  /** one line per source that couldn't be read: said on the page, never shown as "none" */
  errors: string[];
  reload: () => Promise<void>;
}

/** `codexOk` false: Codex isn't available here, so its skills aren't read (and its absence isn't an error). */
export function useAllSkills(codexOk: boolean): AllSkillsView {
  const projects = useStore((s) => s.savedProjects);
  const bin = useHarnessStatus('claude').bin;
  const cwd = currentCwdForNewChat();
  const folders = [...new Set(projects.map((p) => p.roots[0]?.path).filter(Boolean))].sort() as string[];
  const key = folders.join('\n');
  const [view, setView] = useState<Omit<AllSkillsView, 'reload'>>({
    rows: null,
    errors: [],
  });
  const [latest] = useState(() =>
    createLatestLoader(
      (_current, folderList: string[], claudeBin: string | null, claudeCwd: string, withCodex: boolean) =>
        Promise.allSettled([
          withCodex ? listCodexSkills(folderList) : Promise.resolve([]),
          claudeBin ? native.claude.catalog(claudeBin, claudeCwd) : Promise.resolve(null),
          native.plugins.list(),
        ]),
      ([codex, claude, store]) => {
        const why = (r: PromiseSettledResult<unknown>, what: string) =>
          r.status === 'rejected' ? `${what}: ${errorText(r.reason)}` : null;
        const storeList = store.status === 'fulfilled' ? store.value : { plugins: [], error: null };
        setView({
          rows: mergeSkills({
            codex: codex.status === 'fulfilled' ? codex.value : [],
            claude: claude.status === 'fulfilled' ? (claude.value?.skills ?? []) : [],
            plugins: storeList.plugins,
          }),
          errors: [
            why(codex, `${HARNESS_LABEL.codex} skills`),
            why(claude, `${HARNESS_LABEL.claude} skills`),
            why(store, 'Plugin skills'),
            storeList.error && `Plugin skills: ${storeList.error}`,
          ].filter(Boolean) as string[],
        });
      },
    ),
  );
  const reload = useCallback(() => {
    void latest.load(key ? key.split('\n') : [], bin, cwd, codexOk);
    return latest.settled();
  }, [latest, key, bin, cwd, codexOk]);
  useEffect(() => {
    void reload();
    // the store changed (a plugin installed, turned off): its skills change with it
    const off = native.plugins.onChanged(() => void reload());
    return () => {
      off();
      latest.cancel();
    };
  }, [reload, latest]);
  return { ...view, reload };
}
