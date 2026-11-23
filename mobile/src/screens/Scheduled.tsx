// The Scheduled destination as Claude for iOS draws it: one list of everything that runs on a timer, MoMo's routines and the Mac's scheduled chats, in Claude's row style; MoMo's proposals wait at the top, and a routine's row opens Pause or Resume and Run now.
import { useMemo, useRef, useState } from 'react';
import { useOwnedRequest } from '../remote/useOwnedRequest';
import { ScrollView, Text, View } from 'react-native';
import type { MobileRuntime } from '../contracts';
import { BottomSheet } from '../components/BottomSheet';
import { GlassCircle } from '../components/Glass';
import { Group, GroupItem } from '../components/Grouped';
import { Icon } from '../components/Icon';
import { PageHeader } from '../components/PageHeader';
import { SectionHeader } from '../components/SessionRow';
import { Button, ErrorLine, useStyles } from '../components/ui';
import { createMomoApi, messageOf } from '../momo/api';
import type { Proposal, Routine, Routines } from '../momo/contract';
import { useLoad } from '../momo/useLoad';
import { useKnownMachines } from '../remote/knownMachines';
import { loadScheduled, taskLine, type ScheduledTask } from '../remote/scheduled';
import { useTheme } from '../theme';
import { useHardwareBack } from '../useHardwareBack';
import { typo } from '../typography';

/** One row of the list: a MoMo routine, or a chat the Mac starts on a schedule. */
export type Timed = { kind: 'routine'; routine: Routine } | { kind: 'task'; task: ScheduledTask };

/** The rows in one list: MoMo's routines first (running ones before paused), then the Mac's tasks soonest first. */
export function timedRows(routines: Routine[], tasks: ScheduledTask[]): Timed[] {
  const byPaused = [...routines].sort((a, b) => Number(a.paused) - Number(b.paused));
  const bySoonest = [...tasks].sort((a, b) => (a.next ?? Number.POSITIVE_INFINITY) - (b.next ?? Number.POSITIVE_INFINITY));
  return [
    ...byPaused.map((routine) => ({ kind: 'routine' as const, routine })),
    ...bySoonest.map((task) => ({ kind: 'task' as const, task })),
  ];
}

/** A routine's grey line: who runs it and when, "Paused" first when it is. */
export const routineLine = (r: Routine) => (r.paused ? `MoMo · Paused · ${r.schedule}` : `MoMo · ${r.schedule}`);

export function Scheduled({ runtime, back }: { runtime: MobileRuntime; back: () => void }) {
  const styles = useStyles();
  const theme = useTheme();
  const request = useOwnedRequest(runtime);
  const api = useMemo(() => createMomoApi(runtime), [runtime]);
  const [version, setVersion] = useState(0);
  const tasks = useLoad(runtime, () => loadScheduled(request), [request, version]);
  // MoMo's part only for an account the Mac says MoMo is open to (its hello); MoMo itself is never asked otherwise
  const routines = useLoad(runtime, async (): Promise<Routines | null> => ((await api.allowed()) ? api.routines() : null), [api, version]);
  // the machines name where a Host's task runs, as the Chats list names a Host's chat
  const machines = useKnownMachines();
  const [open, setOpen] = useState<Routine | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);
  useHardwareBack(back, open === null);
  async function act(work: () => Promise<unknown>) {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setError(null);
    try {
      await work();
      setOpen(null);
      setVersion((v) => v + 1);
    } catch (e) {
      setError(messageOf(e));
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }
  const loaded = tasks.data && 'tasks' in tasks.data ? tasks.data.tasks : [];
  const rows = timedRows(routines.data?.routines ?? [], loaded);
  const proposals: Proposal[] = routines.data?.proposals ?? [];
  const waiting = !tasks.data && !tasks.error;
  const clock = (paused = false) => <Icon name={paused ? 'pause.circle' : 'clock'} glyph="◷" size={20} color={theme.ink2} />;
  return (
    <View style={styles.page}>
      <PageHeader
        title="Scheduled"
        left={
          <GlassCircle label="Back" onPress={back}>
            <Icon name="chevron.left" glyph="‹" size={20} color={theme.ink} />
          </GlassCircle>
        }
      />
      <ScrollView contentContainerStyle={{ paddingBottom: 40 }}>
        <View style={{ paddingHorizontal: 24, gap: 8 }}>
          <ErrorLine text={error ?? tasks.error ?? routines.error} />
          {!!(tasks.error || routines.error) && <Button secondary title="Retry" onPress={() => setVersion((v) => v + 1)} />}
        </View>
        {proposals.length > 0 && (
          <>
            <SectionHeader title="MoMo suggests" />
            {proposals.map((p) => (
              <View key={p.id} style={{ paddingHorizontal: 24, paddingVertical: 10, gap: 4 }}>
                <Text style={{ ...typo.body, color: theme.ink }}>{p.name}</Text>
                <Text style={{ ...typo.subhead, color: theme.ink2 }}>{p.schedule}</Text>
                <Text style={{ ...typo.subhead, color: theme.ink }}>{p.prompt}</Text>
                {!!p.sources && <Text style={{ ...typo.subhead, color: theme.ink2 }}>Reads: {p.sources}</Text>}
                <View style={{ flexDirection: 'row', marginTop: 6 }}>
                  <Button title="Approve" disabled={busy} onPress={() => void act(() => api.approve(p.id, p.rev))} />
                </View>
              </View>
            ))}
          </>
        )}
        {rows.length > 0 && <SectionHeader title="Upcoming" />}
        {/* the group rows have 16 pt of their own: 8 more puts them on the 24 pt line the section titles use */}
        <View style={{ paddingHorizontal: 8 }}>
          {rows.map((row) =>
            row.kind === 'routine' ? (
              <GroupItem
                key={`r:${row.routine.id}`}
                title={row.routine.name}
                detail={routineLine(row.routine)}
                icon={clock(row.routine.paused)}
                onPress={() => setOpen(row.routine)}
              />
            ) : (
              <GroupItem key={`t:${row.task.id}`} title={row.task.name} detail={taskLine(row.task, machines, Date.now())} icon={clock()} />
            ),
          )}
        </View>
        {waiting && <Text style={[styles.muted, { paddingHorizontal: 24 }]}>Loading scheduled tasks…</Text>}
        {tasks.data && 'old' in tasks.data && <Text style={[styles.muted, { paddingHorizontal: 24 }]}>{tasks.data.old}</Text>}
        {!waiting && !rows.length && !proposals.length && !(tasks.data && 'old' in tasks.data) && !tasks.error && (
          <Text style={[styles.muted, { paddingHorizontal: 24, paddingTop: 18 }]}>Nothing is scheduled on this computer.</Text>
        )}
        <Text style={[styles.muted, { paddingHorizontal: 24, paddingTop: 18 }]}>Change schedules on your computer.</Text>
      </ScrollView>
      <BottomSheet open={open !== null} title={open?.name ?? ''} onClose={() => setOpen(null)}>
        {open && (
          <Group>
            <GroupItem
              key="pause"
              title={open.paused ? 'Resume' : 'Pause'}
              onPress={busy ? undefined : () => void act(() => api.routine(open.paused ? 'resume' : 'pause', open.id))}
            />
            <GroupItem key="run" title="Run now" onPress={busy ? undefined : () => void act(() => api.routine('run', open.id))} />
          </Group>
        )}
        <ErrorLine text={error} />
      </BottomSheet>
    </View>
  );
}
