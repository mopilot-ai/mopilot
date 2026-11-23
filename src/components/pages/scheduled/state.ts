// Shared scheduled-task list, selection, editing state and blank-task defaults.
import { create } from 'zustand';
import { toast } from '../../../store/core';
import { currentCwdForNewChat } from '../../../store/projects';
import { savedDefaultResolved } from '../../../store/chats';
import { listAutomations, PRESETS, type Automation } from '../../../lib/automations';
import { errorText } from '../../../lib/ignored';
import { createLatestLoader } from '../../../lib/latestLoader';

/* shared state between the sidebar list and the main pane */
export const useSched = create<{
  list: Automation[] | null;
  selected: string | null;
  editing: Automation | null;
  filter: 'all' | 'active' | 'paused';
  query: string;
}>(() => ({ list: null, selected: null, editing: null, filter: 'all', query: '' }));

const taskLoader = createLatestLoader(
  (current) =>
    listAutomations((message) => {
      if (current()) toast(message, 'error');
    }),
  (list) => useSched.setState({ list }),
  (error) => toast(`Couldn't load scheduled tasks: ${errorText(error)}`, 'error'),
);

/** Read the task list again; errors are toasted and the last list stays. Older replies cannot replace it. */
export const reload = () => taskLoader.load();

export function blank(over: Partial<Automation> = {}): Automation {
  // a new task runs with the harness new chats start on now; each task keeps its own after that
  const runWith = savedDefaultResolved().kind;
  return {
    version: 1,
    id: '',
    kind: 'cron',
    name: '',
    prompt: '',
    status: 'ACTIVE',
    rrule: PRESETS[1].rule,
    harness: runWith,
    cwds: [currentCwdForNewChat()],
    execution_environment: 'local',
    ...over,
  };
}
