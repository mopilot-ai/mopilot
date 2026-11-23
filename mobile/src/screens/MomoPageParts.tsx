// The pages inside MoMo's page: a routine (edit, pause, run, delete; or approve and decline a suggestion), proactivity, quiet hours, the brain's effort, About you, and what MoMo recently learned with Undo.
import { useEffect, useState } from 'react';
import { Text, View } from 'react-native';
import type { MobileRuntime } from '../contracts';
import { Group, GroupItem, GroupLabel } from '../components/Grouped';
import { Button, ErrorLine, Field, useStyles } from '../components/ui';
import { messageOf, type MomoApi } from '../momo/api';
import type { Proposal, Routine } from '../momo/contract';
import { levelLabel, type BrainChoice, type Change, type PastFact, type Prefs } from '../momo/pageContract';
import { capabilities, loadOptions, type Effort } from '../remote/client';
import { useOwnedRequest } from '../remote/useOwnedRequest';

/** Runs one change at a time and reports how it went; the page reads again after each one that succeeds. */
export type Act = (work: (api: MomoApi) => Promise<unknown>, after?: () => void) => void;

/** What the Mac lets a phone do to a routine beyond pause, resume, run and approve: edit it, and delete it (or decline a suggestion). */
/** `run` is false while MoMo is paused: the one routine action the Mac refuses then. */
export type RoutineCan = { edit: boolean; remove: boolean; run: boolean };

export function RoutinePage({
  item,
  act,
  busy,
  can,
}: {
  item: { routine: Routine } | { proposal: Proposal };
  act: Act;
  busy: boolean;
  can: RoutineCan;
}) {
  const styles = useStyles();
  if ('proposal' in item) {
    const p = item.proposal;
    return (
      <View style={{ gap: 12 }}>
        <Text style={styles.muted}>Suggested by MoMo · {p.schedule}</Text>
        <Text style={styles.text}>{p.prompt}</Text>
        {!!p.sources && <Text style={styles.muted}>Reads: {p.sources}</Text>}
        <Group>
          <GroupItem key="approve" title="Approve" tone="link" onPress={busy ? undefined : () => act((api) => api.approve(p.id, p.rev))} />
          {can.remove && (
            <GroupItem
              key="decline"
              title="Decline"
              tone="danger"
              onPress={busy ? undefined : () => act((api) => api.deleteRoutine(p.id))}
            />
          )}
        </Group>
      </View>
    );
  }
  return <ApprovedRoutine routine={item.routine} act={act} busy={busy} can={can} />;
}

/** Deleting a routine asks once more, as forgetting a memory does: the first tap arms it, Cancel leaves it as it was. */
function DeleteRoutine({ busy, remove }: { busy: boolean; remove: () => void }) {
  const [confirming, setConfirming] = useState(false);
  if (!confirming)
    return <GroupItem key="delete" title="Delete routine" tone="danger" onPress={busy ? undefined : () => setConfirming(true)} />;
  return (
    <>
      <GroupItem key="confirm" title="Confirm delete" tone="danger" onPress={busy ? undefined : remove} />
      <GroupItem key="cancel" title="Cancel" onPress={() => setConfirming(false)} />
    </>
  );
}

function ApprovedRoutine({ routine, act, busy, can }: { routine: Routine; act: Act; busy: boolean; can: RoutineCan }) {
  const styles = useStyles();
  const [name, setName] = useState(routine.name);
  const [prompt, setPrompt] = useState(routine.prompt ?? '');
  const changed = name.trim() !== routine.name || (routine.prompt !== undefined && prompt.trim() !== routine.prompt);
  return (
    <View style={{ gap: 12 }}>
      <Text style={styles.muted}>{routine.paused ? `Paused · ${routine.schedule}` : routine.schedule}</Text>
      {can.edit && (
        <>
          <Field placeholder="Name" value={name} onChangeText={setName} />
          {routine.prompt !== undefined && <Field multiline placeholder="What it does" value={prompt} onChangeText={setPrompt} />}
          <Button
            title="Save"
            disabled={busy || !changed || !name.trim()}
            onPress={() =>
              act((api) =>
                api.editRoutine(routine.id, {
                  ...(name.trim() !== routine.name ? { name: name.trim() } : {}),
                  ...(routine.prompt !== undefined && prompt.trim() !== routine.prompt ? { prompt: prompt.trim() } : {}),
                }),
              )
            }
          />
        </>
      )}
      <Group>
        <GroupItem
          key="pause"
          title={routine.paused ? 'Resume' : 'Pause'}
          onPress={busy ? undefined : () => act((api) => api.routine(routine.paused ? 'resume' : 'pause', routine.id))}
        />
        <GroupItem
          key="run"
          title="Run now"
          detail={can.run ? undefined : 'Resume MoMo to run it'}
          onPress={busy || !can.run ? undefined : () => act((api) => api.routine('run', routine.id))}
        />
        {can.remove && <DeleteRoutine busy={busy} remove={() => act((api) => api.deleteRoutine(routine.id))} />}
      </Group>
    </View>
  );
}

/** How often MoMo reaches out, from the levels the Mac lists. */
export function ProactivityPage({ prefs, act, busy }: { prefs: Prefs; act: Act; busy: boolean }) {
  return (
    <Group>
      {prefs.levels.map((id) => (
        <GroupItem
          key={id}
          title={levelLabel(id)}
          end={id === prefs.proactivity ? 'check' : 'none'}
          onPress={busy || id === prefs.proactivity ? undefined : () => act((api) => api.setPref({ proactivity: id }))}
        />
      ))}
    </Group>
  );
}

const CLOCK = /^([01]\d|2[0-3]):[0-5]\d$/;

/** Quiet hours: off, or from one time to another (HH:MM), as the Mac takes them. */
export function QuietHoursPage({ prefs, act, busy }: { prefs: Prefs; act: Act; busy: boolean }) {
  const styles = useStyles();
  const [start, setStart] = useState(prefs.quietHours?.start ?? '22:00');
  const [end, setEnd] = useState(prefs.quietHours?.end ?? '07:00');
  const valid = CLOCK.test(start) && CLOCK.test(end) && start !== end;
  return (
    <View style={{ gap: 12 }}>
      <Text style={styles.muted}>MoMo holds its reminders and suggestions between these times.</Text>
      <Field placeholder="From (22:00)" value={start} onChangeText={setStart} />
      <Field placeholder="Until (07:00)" value={end} onChangeText={setEnd} />
      <Button title="Save" disabled={busy || !valid} onPress={() => act((api) => api.setPref({ quietHours: { start, end } }))} />
      {prefs.quietHours && (
        <Button secondary title="Turn off" disabled={busy} onPress={() => act((api) => api.setPref({ quietHours: null }))} />
      )}
    </View>
  );
}

/** The efforts the brain's model offers on the Mac, the current one checked. */
export function EffortPage({ runtime, brain, act, busy }: { runtime: MobileRuntime; brain: BrainChoice; act: Act; busy: boolean }) {
  const styles = useStyles();
  const request = useOwnedRequest(runtime);
  const [efforts, setEfforts] = useState<Effort[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    capabilities(request)
      .then((caps) => loadOptions(request, brain.harness, caps.ceiling))
      .then((options) => alive && setEfforts(options.models.find((m) => m.id === brain.model)?.efforts ?? []))
      .catch((e: unknown) => alive && setError(messageOf(e)));
    return () => {
      alive = false;
    };
  }, [request, brain.harness, brain.model]);
  if (error) return <ErrorLine text={error} />;
  if (!efforts) return <Text style={styles.muted}>Loading…</Text>;
  if (!efforts.length) return <Text style={styles.muted}>This model has no effort setting.</Text>;
  return (
    <Group>
      {efforts.map((e) => (
        <GroupItem
          key={e.id}
          title={e.label}
          end={e.id === brain.effort ? 'check' : 'none'}
          onPress={busy || e.id === brain.effort ? undefined : () => act((api) => api.setEffort(brain, e.id))}
        />
      ))}
    </Group>
  );
}

/** About you: the document MoMo keeps of the user, editable here; MoMo's own persona stays on the Mac. */
export function AboutYouPage({ api, act, busy }: { api: MomoApi; act: Act; busy: boolean }) {
  const styles = useStyles();
  const [text, setText] = useState<string | null>(null);
  const [saved, setSaved] = useState('');
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    api.docs().then(
      (d) => alive && (setText(d.aboutYou), setSaved(d.aboutYou)),
      (e: unknown) => alive && setError(messageOf(e)),
    );
    return () => {
      alive = false;
    };
  }, [api]);
  if (error) return <ErrorLine text={error} />;
  if (text === null) return <Text style={styles.muted}>Loading…</Text>;
  return (
    <View style={{ gap: 12 }}>
      <Field multiline placeholder="What MoMo should know about you" value={text} onChangeText={setText} style={{ minHeight: 160 }} />
      <Button
        title="Save"
        disabled={busy || text === saved}
        onPress={() =>
          act(
            (a) => a.writeAboutYou(text),
            () => setSaved(text),
          )
        }
      />
    </View>
  );
}

/** What MoMo learned lately, newest first, with Undo while it can still be taken back; then what newer facts replaced. */
export function LearnedPage({ changes, past, act, busy }: { changes: Change[]; past: PastFact[]; act: Act; busy: boolean }) {
  const styles = useStyles();
  return (
    <View>
      {!changes.length && <Text style={styles.muted}>Nothing learned lately.</Text>}
      {changes.length > 0 && (
        <Group>
          {changes.map((c) => (
            <GroupItem
              key={c.id}
              title={`${c.verb}${c.lines.length ? `: ${c.lines.join('; ')}` : ''}`}
              detail={`${c.by} · ${new Date(c.at).toLocaleDateString()}${c.undone ? ' · Undone' : ''}`}
              trailing={
                c.undoable ? <Button secondary title="Undo" disabled={busy} onPress={() => act((api) => api.undo(c.id))} /> : undefined
              }
            />
          ))}
        </Group>
      )}
      {past.length > 0 && (
        <>
          <GroupLabel>Replaced</GroupLabel>
          <Group>
            {past.map((f) => (
              <GroupItem key={f.id} title={f.text} />
            ))}
          </Group>
        </>
      )}
    </View>
  );
}
