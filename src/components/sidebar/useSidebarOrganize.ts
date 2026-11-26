// How the sidebar is organized now: the saved choice, except that "By machine" needs Host, so without it (once main has said so) the sidebar is by project.
import { useStore } from '../../store/core';
import { useHostAccess, useHostAnswered } from '../../lib/host';

export function useSidebarOrganize(): 'project' | 'list' | 'machine' {
  const saved = useStore((s) => s.prefs.sidebarOrganize ?? 'project');
  const on = useHostAccess();
  const answered = useHostAnswered();
  return saved === 'machine' && answered && !on ? 'project' : saved;
}
