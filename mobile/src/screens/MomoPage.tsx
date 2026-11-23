// MoMo's page, behind its name in the header (ChatGPT dots' profile): who MoMo is and whether it runs, what needs you, its routines, what it knows, its sources and its settings; each part shows only when the Mac offers its method.
import { useCallback, useEffect, useState } from 'react';
import { Text, View } from 'react-native';
import { Tap } from '../ui/ds/Tap';
import type { MobileRuntime } from '../contracts';
import { BottomSheet } from '../components/BottomSheet';
import { BrainPicker } from '../components/BrainPicker';
import { Group, GroupItem, GroupLabel } from '../components/Grouped';
import { Spark } from '../components/Spark';
import { useKnownMachines } from '../remote/knownMachines';
import { MomoComputers } from './MomoComputers';
import { ErrorLine, useStyles } from '../components/ui';
import { messageOf, type MomoApi } from '../momo/api';
import type { MomoCache } from '../momo/cache';
import type { Proposal, Routine, Routines } from '../momo/contract';
import { brainName, effortLabel, levelLabel } from '../momo/pageContract';
import { TASKS_METHOD, type Task } from '../momo/tasksContract';
import { MARK_METHOD, type PanelMark, type PanelTab, type PanelTask } from '../momo/taskPanelContract';
import type { MomoState } from '../momo/stateContract';
import { useLoad, type Guard, type Loaded } from '../momo/useLoad';
import { useTheme } from '../theme';
import { MomoMemory } from './MomoMemory';
import { TaskPage, TasksGroups } from './MomoTasks';
import { PanelTaskPage, TaskTabs, UndoLine } from './MomoTaskTabs';
import { SuggestionPage } from './MomoSuggestions';
import { suggestionsShown, type Suggestion } from '../momo/suggestionsContract';
import { useTranslation } from '../ui/i18n';
import { AboutYouPage, type Act, EffortPage, LearnedPage, ProactivityPage, QuietHoursPage, RoutinePage } from './MomoPageParts';
import { typo } from '../typography';

type Page =
  | { kind: 'main' }
  | { kind: 'routine'; item: { routine: Routine } | { proposal: Proposal } }
  | { kind: 'task'; task: Task }
  | { kind: 'ptask'; task: PanelTask; now: number }
  | { kind: 'suggestion'; suggestion: Suggestion }
  | { kind: 'memories' | 'about' | 'learned' | 'proactivity' | 'quiet' | 'effort' | 'brain' };

const TITLE: Record<Exclude<Page['kind'], 'main' | 'routine' | 'task' | 'ptask' | 'suggestion'>, string> = {
  memories: 'Memories',
  about: 'About you',
  learned: 'Recently learned',
  proactivity: 'Proactivity',
  quiet: 'Quiet hours',
  effort: 'Effort',
  brain: 'Brain',
};

/** "22:00–07:00", or Off. */
export const quietLine = (q: { start: string; end: string } | null) => (q ? `${q.start}–${q.end}` : 'Off');

export function MomoPage({
  open,
  close,
  runtime,
  api,
  guard,
  has,
  online,
  state,
  waiting,
  showWaiting,
  routines,
  brainSet,
  version,
  cache,
  scope,
  memoryVersion,
  start = null,
  computers,
}: {
  open: boolean;
  close: () => void;
  runtime: MobileRuntime;
  api: MomoApi;
  guard: Guard;
  /** whether the Mac lists a method */
  has: (method: string) => boolean;
  online: boolean;
  state: MomoState | null;
  waiting: number;
  /** close the page and scroll the chat to the first thing waiting */
  /** the chat where a card is answered: a channel's task names its channel, none is Main's */
  showWaiting: (task?: { ref: string; channel: { id: string; name: string } | null }) => void;
  routines: Loaded<Routines | null>;
  brainSet: boolean;
  /** bumped by momo.changed (prefs, memory, brain): the page reads again */
  version: number;
  cache?: Promise<MomoCache | null>;
  scope: string;
  memoryVersion: number;
  /** the task or suggestion the shell's Tasks tab opened this on: its own page shows first */
  start?: { task: PanelTask; now: number } | { suggestion: Suggestion } | null;
  /** the machines section: a machine's page, the pairing flow and a re-read of the machines; none leaves the section out */
  computers?: { open: (machineId: string) => void; pair: () => void; check: () => Promise<unknown> };
}) {
  const styles = useStyles();
  const machines = useKnownMachines();
  const theme = useTheme();
  const [page, setPage] = useState<Page>({ kind: 'main' });
  /** the Tasks tab shown: kept here, so a suggestion's Add or Hide comes back to the tab it left */
  const [taskTab, setTaskTab] = useState<PanelTab>('active');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { t } = useTranslation();
  /** the line after a mark on a run: what was done, and the token that takes it back (kept a minute) */
  const [undo, setUndo] = useState<{ taskId: string; token: string; label: string } | null>(null);
  const [mine, setMine] = useState(0);
  useEffect(() => {
    if (open && start) setPage('suggestion' in start ? { kind: 'suggestion', suggestion: start.suggestion } : { kind: 'ptask', ...start });
  }, [open, start]);
  const live = open && online;
  const prefs = useLoad(runtime, () => (live && has('momo.prefs.get') ? guard(api.prefs) : Promise.resolve(null)), [
    api,
    live,
    version,
    mine,
  ]);
  const brain = useLoad(runtime, () => (live ? guard(api.brainChoice) : Promise.resolve(null)), [api, live, version, mine]);
  const sources = useLoad(runtime, () => (live ? guard(api.sources) : Promise.resolve(null)), [api, live, version]);
  const learned = useLoad(
    runtime,
    () => (live && has('momo.memory.changes') ? guard(() => Promise.all([api.changes(), api.past()])) : Promise.resolve(null)),
    [api, live, memoryVersion, mine],
  );
  // the Mac's own Tasks list (A1), read again as the cards waiting, memory or anything MoMo changed moves; an older Mac lists none
  const tasks = useLoad(runtime, () => (live && has(TASKS_METHOD) ? guard(api.tasks) : Promise.resolve(null)), [
    api,
    live,
    version,
    memoryVersion,
    waiting,
    mine,
  ]);
  // what MoMo suggested for Up next (A7), read again with the tasks, where the Mac has the panel and lists both methods
  const suggested = useLoad(
    runtime,
    () =>
      live && has(MARK_METHOD) && !!tasks.data?.panel && suggestionsShown(state, has) ? guard(api.suggestions) : Promise.resolve(null),
    [api, live, version, memoryVersion, waiting, mine, !!tasks.data?.panel, state?.suggestions],
  );
  const main = useCallback(() => {
    setPage({ kind: 'main' });
    setError(null);
  }, []);
  const shut = () => {
    main();
    close();
  };
  const act: Act = (work, after) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    guard(() => work(api)).then(
      () => {
        setBusy(false);
        after?.();
        setMine((n) => n + 1);
        routines.reload();
        // a routine done with goes back to the list; a setting stays where it is, showing its new value
        if (page.kind === 'routine') main();
      },
      (e: unknown) => {
        setBusy(false);
        setError(messageOf(e));
      },
    );
  };
  /** The user's mark on a run; the Mac answers a token when there is something to take back. */
  const mark = (task: PanelTask, what: PanelMark) =>
    act(async (a) => {
      const r = await a.markTask(task.id, what);
      setUndo(
        what !== 'reopen' && r.undoToken
          ? { taskId: task.id, token: r.undoToken, label: t(what === 'done' ? 'momoTasks.markedDone' : 'momoTasks.archivedNow') }
          : null,
      );
    }, main);
  const takeBack = () => {
    const u = undo;
    setUndo(null);
    if (u) act((a) => a.markTask(u.taskId, 'reopen', u.token));
  };
  const paused = state?.status === 'paused';
  const statusLine = paused ? 'Paused' : state?.status === 'online' && online ? 'Online' : online && !state ? 'Online' : 'Offline';
  const canPause = has('momo.prefs.set') && !!state;
  const p = prefs.data;
  /** the four-tab list, where the Mac has the panel on and takes the user's mark */
  const panel = has(MARK_METHOD) ? (tasks.data?.panel ?? null) : null;
  /** the first read of the Mac's tasks failed, where the Mac has the panel's methods: the error with Try again, not the older list */
  const failedFirst = !!tasks.error && !tasks.data && has(TASKS_METHOD) && has(MARK_METHOD);
  const b = brain.data;
  const title =
    page.kind === 'main'
      ? (state?.name ?? 'MoMo')
      : page.kind === 'routine'
        ? 'routine' in page.item
          ? page.item.routine.name
          : page.item.proposal.name
        : page.kind === 'task' || page.kind === 'ptask'
          ? page.task.title
          : page.kind === 'suggestion'
            ? page.suggestion.title
            : TITLE[page.kind];
  return (
    <BottomSheet
      open={open}
      title={title}
      onClose={shut}
      onBack={page.kind === 'main' ? undefined : page.kind === 'effort' ? () => setPage({ kind: 'brain' }) : main}
    >
      <ErrorLine text={error ?? prefs.error ?? learned.error} />
      {page.kind === 'main' && (
        <View>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 14, paddingHorizontal: 4, paddingBottom: 16 }}>
            <View
              style={{
                width: 56,
                height: 56,
                borderRadius: 28,
                alignItems: 'center',
                justifyContent: 'center',
                backgroundColor: theme.surface,
              }}
            >
              <Spark size={30} />
            </View>
            <View style={{ flex: 1 }}>
              <Text style={{ ...typo.bodySemibold, color: theme.ink }}>{state?.name ?? 'MoMo'}</Text>
              <Text style={{ ...typo.subhead, color: theme.ink2 }}>{statusLine}</Text>
            </View>
            {canPause && (
              <Tap
                accessibilityRole="button"
                accessibilityLabel={paused ? 'Resume' : 'Pause'}
                disabled={busy || !online}
                onPress={() => act((a) => a.setPaused(!paused))}
                style={{ minHeight: 36, paddingHorizontal: 16, borderRadius: 18, justifyContent: 'center', backgroundColor: theme.sunken }}
              >
                <Text style={{ ...typo.subhead, color: theme.ink }}>{paused ? 'Resume' : 'Pause'}</Text>
              </Tap>
            )}
          </View>
          {undo && <UndoLine key={undo.token} label={undo.label} undo={takeBack} expire={() => setUndo(null)} />}
          {!!tasks.error && (!!panel || failedFirst) && (
            <Group>
              <GroupItem
                key="failed"
                title={t('momoTasks.readFailed')}
                value={t('momoTasks.tryAgain')}
                tone="link"
                onPress={tasks.reload}
              />
            </Group>
          )}
          {panel ? (
            <TaskTabs
              view={panel}
              stale={!!tasks.error}
              review={showWaiting}
              open={(task) => setPage({ kind: 'ptask', task, now: panel.now })}
              pauseAll={() => act((a) => a.setPaused(!panel.paused))}
              busy={busy}
              toggle={(task) => act((a) => a.routine(task.paused ? 'resume' : 'pause', task.ref))}
              suggestions={suggested.data}
              openSuggestion={(suggestion) => setPage({ kind: 'suggestion', suggestion })}
              tab={taskTab}
              onTab={setTaskTab}
            />
          ) : tasks.data ? (
            <TasksGroups
              tasks={tasks.data.tasks}
              open={(task) => (task.kind === 'card' ? showWaiting(task) : setPage({ kind: 'task', task }))}
            />
          ) : failedFirst ? null : (
            <>
              <GroupLabel>Needs you</GroupLabel>
              <Group>
                {waiting > 0 ? (
                  <GroupItem key="needs" title={`${waiting} waiting for you`} end="chevron" onPress={() => showWaiting()} />
                ) : (
                  <GroupItem key="none" title="Nothing right now" />
                )}
              </Group>
            </>
          )}
          {!panel && !failedFirst && routines.data && (routines.data.routines.length > 0 || routines.data.proposals.length > 0) && (
            <>
              <GroupLabel>Scheduled</GroupLabel>
              <Group>
                {routines.data.routines.map((r) => (
                  <GroupItem
                    key={`r:${r.id}`}
                    title={r.name}
                    detail={r.schedule}
                    value={r.paused ? 'Paused' : 'On'}
                    end="chevron"
                    onPress={() => setPage({ kind: 'routine', item: { routine: r } })}
                  />
                ))}
                {routines.data.proposals.map((pr) => (
                  <GroupItem
                    key={`p:${pr.id}`}
                    title={pr.name}
                    detail="Suggested by MoMo"
                    value="Review"
                    end="chevron"
                    onPress={() => setPage({ kind: 'routine', item: { proposal: pr } })}
                  />
                ))}
              </Group>
            </>
          )}
          <GroupLabel>What MoMo knows</GroupLabel>
          <Group>
            {has('momo.memory.writeDoc') && (
              <GroupItem key="about" title="About you" end="chevron" onPress={() => setPage({ kind: 'about' })} />
            )}
            <GroupItem key="memories" title="Memories" end="chevron" onPress={() => setPage({ kind: 'memories' })} />
            {has('momo.memory.changes') && (
              <GroupItem key="learned" title="Recently learned" end="chevron" onPress={() => setPage({ kind: 'learned' })} />
            )}
          </Group>
          {sources.data && (
            <>
              <GroupLabel>Sources</GroupLabel>
              <Group>
                <GroupItem key="cal" title="Calendar" value={sources.data.calendar ? 'Connected' : 'Not connected'} />
                <GroupItem key="rem" title="Reminders" value={sources.data.reminders ? 'Connected' : 'Not connected'} />
              </Group>
              {(!sources.data.calendar || !sources.data.reminders) && (
                <Text style={[styles.muted, { paddingHorizontal: 16, marginTop: -8, marginBottom: 16 }]}>Connect them on your Mac.</Text>
              )}
            </>
          )}
          {computers && !!machines?.length && <MomoComputers machines={machines} {...computers} />}
          {(p || b) && <GroupLabel>Settings</GroupLabel>}
          {(p || b) && (
            <Group>
              {p && (
                <GroupItem
                  key="pro"
                  title="Proactivity"
                  value={levelLabel(p.proactivity)}
                  end="chevron"
                  onPress={() => setPage({ kind: 'proactivity' })}
                />
              )}
              {p && (
                <GroupItem
                  key="quiet"
                  title="Quiet hours"
                  value={quietLine(p.quietHours)}
                  end="chevron"
                  onPress={() => setPage({ kind: 'quiet' })}
                />
              )}
              {b && <GroupItem key="brain" title="Brain" value={brainName(b)} end="chevron" onPress={() => setPage({ kind: 'brain' })} />}
            </Group>
          )}
        </View>
      )}
      {page.kind === 'routine' && (
        <RoutinePage
          item={page.item}
          act={act}
          busy={busy}
          can={{ edit: has('momo.routines.edit'), remove: has('momo.routines.delete'), run: !paused }}
        />
      )}
      {page.kind === 'task' && <TaskPage task={page.task} act={act} busy={busy} done={main} />}
      {page.kind === 'suggestion' && <SuggestionPage suggestion={page.suggestion} act={act} busy={busy} done={main} started={shut} />}
      {page.kind === 'ptask' && <PanelTaskPage task={page.task} act={act} busy={busy} done={main} mark={mark} now={page.now} />}
      {page.kind === 'memories' && (
        <MomoMemory runtime={runtime} api={api} cache={cache} scope={scope} online={online} guard={guard} version={memoryVersion} />
      )}
      {page.kind === 'about' && <AboutYouPage api={api} act={act} busy={busy} />}
      {page.kind === 'learned' && learned.data && <LearnedPage changes={learned.data[0]} past={learned.data[1]} act={act} busy={busy} />}
      {page.kind === 'proactivity' && p && <ProactivityPage prefs={p} act={act} busy={busy} />}
      {page.kind === 'quiet' && p && <QuietHoursPage prefs={p} act={act} busy={busy} />}
      {page.kind === 'brain' && b && (
        <View>
          <Group>
            <GroupItem key="now" title="Model" value={brainName(b)} />
            {/* changed from the phone only where the Mac allows brain changes; otherwise shown as it is */}
            <GroupItem
              key="effort"
              title="Effort"
              value={effortLabel(b.effort)}
              end={brainSet ? 'chevron' : 'none'}
              onPress={brainSet ? () => setPage({ kind: 'effort' }) : undefined}
            />
          </Group>
          {brainSet && <BrainPicker runtime={runtime} api={api} done={main} />}
        </View>
      )}
      {page.kind === 'effort' && b && <EffortPage runtime={runtime} brain={b} act={act} busy={busy} />}
    </BottomSheet>
  );
}
