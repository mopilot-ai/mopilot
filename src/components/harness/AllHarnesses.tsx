// Settings → Harnesses → All harnesses: "New chats use" (a model of a harness that can start a chat), whether new chats
// follow the last used instead, and the default's effort (session/newChatStart.ts), then one row per
// installed harness (HarnessRows.tsx: quiet while ready, else its state and one thing to do), opening its page; one
// not installed is under Install another harness. Around the list, Update all and Check for updates
// (HarnessUpdatesBar), and the way to Accounts & billing.
import { Fragment } from 'react';
import { chooseDefaultHarness } from '../../store/connection';
import { savedDefaultHarness, savedDefaultResolved } from '../../store/chats';
import { defaultHarnessNote, harnessKindLabel } from '../../harness/defaultHarness';
import { navigate } from '../../store/panes';
import { toastFailure, useStore } from '../../store/core';
import { native } from '../../lib/native';
import { harnessPhase } from '../../harness/accountView';
import { HARNESS_IDS, HARNESS_LABEL, type HarnessId } from '../../harness/types';
import type { HarnessKind } from '../../harness/adapter';
import { useFreshBasics } from '../../session/harness/acp';
import { admittedBasics, installedBasics } from '../../harness/launch';
import { Group, Row, Select, Toggle } from '../pages/Settings';
import { HarnessUpdatesBanner, HarnessUpdatesFoot } from './HarnessUpdatesBar';
import { selectionFor, setSelection, useHarnessModels, useHarnessStatus } from '../../session/harness/select';
import { newChatStartMode, setNewChatDefault, setNewChatStart, type NewChatStart } from '../../session/newChatStart';
import { isFirstTier } from '../../harness/adapter';
import { effortLabel } from '../../lib/format';
import { groupModels } from '../../harness/modelGroups';
import type { HarnessModel } from '../../harness/types';
import type { AppState } from '../../store/state';
import { RouteNotice } from './RouteNotice';
import { BasicRow, HarnessRow } from './HarnessRows';

/** Every first-class harness's status, read the same way each render (as the welcome flow does). */
function useFirstClassStatus(): Record<HarnessId, Parameters<typeof harnessPhase>[0]> {
  return { codex: useHarnessStatus('codex'), claude: useHarnessStatus('claude') };
}

/** A first-class harness can start a new chat when it is ready, or when it starts with its first chat (Codex idle). */
const canStart = (st: Parameters<typeof harnessPhase>[0]) => ['ready', 'not-started'].includes(harnessPhase(st));

/**
 * The one choice of the harness new chats start on (#1880), the same on All harnesses and on every harness's page:
 * the harnesses that can start a new chat now, first-class first, then admitted basic ones. Exactly one is chosen; a
 * saved default that can't run is still listed, so the select never shows a value it doesn't offer.
 */
/** A first-tier choice names its model too ('claude::opus'): picking one sets the harness and the model new chats use. */
const SEP = '::';
const modelChoice = (h: HarnessId, m: HarnessModel) => ({ value: `${h}${SEP}${m.id}`, label: `${HARNESS_LABEL[h]} · ${m.label}` });

/** The fixed default saved for `h` while new chats start from it, else null. */
const fixedFor = (s: AppState, h: HarnessId) =>
  newChatStartMode(s) === 'default' && s.prefs.newChatDefault?.harness === h ? s.prefs.newChatDefault : null;
/** The model new chats on `h` start with: the fixed default's, else the harness's own pick. */
const fixedModel = (s: AppState, h: HarnessId) => (fixedFor(s, h) ?? selectionFor(h, s)).model;

function useDefaultChoices(ids: readonly HarnessId[]) {
  const saved = useStore((s) => savedDefaultHarness(s));
  const status = useFirstClassStatus();
  const models: Record<HarnessId, HarnessModel[]> = { codex: useHarnessModels('codex'), claude: useHarnessModels('claude') };
  // the model new chats on the saved harness use: the fixed default's while new chats start from it, else its own pick
  const want = useStore((s) => (isFirstTier(saved) ? fixedModel(s, saved) : null));
  const fixed = useStore((s) => newChatStartMode(s) === 'default');
  const ready = ids.filter((h) => canStart(status[h]));
  // a harness still listing its models is offered by name
  const firstTier = ready.flatMap((h) => {
    const main = groupModels(models[h]).main;
    return main.length ? main.map((m) => modelChoice(h, m)) : [{ value: h as string, label: HARNESS_LABEL[h] }];
  });
  const choices: { value: string; label: string }[] = [
    ...firstTier,
    ...admittedBasics(useStore((s) => s.basicHarnesses)).map((b) => ({ value: `acp:${b.id}` as HarnessKind, label: b.label })),
  ];
  const list = saved === 'codex' || saved === 'claude' ? models[saved] : [];
  const own = list.find((m) => m.id === want) ?? list.find((m) => m.isDefault);
  const value = own && choices.some((c) => c.value === `${saved}${SEP}${own.id}`) ? `${saved}${SEP}${own.id}` : saved;
  if (!choices.some((c) => c.value === value)) choices.push({ value: saved, label: harnessKindLabel(saved) });
  const choose = (v: string) => {
    const [kind, id] = v.split(SEP) as [HarnessKind, string | undefined];
    chooseDefaultHarness(kind);
    const m = id && isFirstTier(kind) ? models[kind].find((x) => x.id === id) : undefined;
    // the fixed default keeps the model and its default effort; a harness picked by name keeps what it uses now
    const now = isFirstTier(kind) ? selectionFor(kind) : null;
    setNewChatDefault(kind, m?.id ?? now?.model ?? null, m ? m.defaultEffort : (now?.effort ?? null));
    // following the last used, the pick is also the model new chats on that harness use next, as it always was
    if (m && !fixed && isFirstTier(kind)) setSelection(kind, { model: m.id, effort: m.defaultEffort }, null);
  };
  return { value, choices, choose };
}

export function DefaultHarnessSelect({ ids = HARNESS_IDS }: { ids?: readonly HarnessId[] }) {
  const { value, choices, choose } = useDefaultChoices(ids);
  return <Select value={value} width={220} options={choices} onChange={choose} />;
}

/**
 * A harness page's "New chats use" row: the one select, the note while the default can't run, and why the page's own
 * harness isn't offered when it can't start a chat yet.
 */
export function NewChatsUseRow({ own }: { own: HarnessKind }) {
  // the saved default's own note: the open draft's pick is not what this page sets
  const note = useStore((s) => defaultHarnessNote(savedDefaultResolved(s)));
  const offered = useDefaultChoices(HARNESS_IDS).choices.some((c) => c.value === own || c.value.startsWith(`${own}${SEP}`));
  return (
    <Row title="New chats use" desc={note ?? (offered ? undefined : 'Only harnesses that are ready are listed.')}>
      <DefaultHarnessSelect />
    </Row>
  );
}

const START_OPTIONS: { value: NewChatStart; label: string }[] = [
  { value: 'last', label: 'Last used' },
  { value: 'default', label: 'The default above' },
];
const START_DESC =
  'Last used: the harness, model and effort of your latest message (the default above until there is one). The default above: always that model, with the effort below.';

/** Whether new chats start with the last used harness, model and effort, or always with the default above. */
function NewChatStartRow() {
  const mode = useStore((s) => newChatStartMode(s));
  return (
    <Row title="New chats start with" desc={START_DESC}>
      <Select value={mode} width={220} options={START_OPTIONS} onChange={setNewChatStart} />
    </Row>
  );
}

/** The fixed default's thinking effort, offered while new chats always start from the default on Codex or Claude Code. */
function DefaultEffortRow() {
  const saved = useStore((s) => savedDefaultHarness(s));
  const h = isFirstTier(saved) ? saved : null;
  const fixed = useStore((s) => (h ? fixedFor(s, h) : null));
  const models = useHarnessModels(h ?? 'codex');
  const model = models.find((m) => m.id === fixed?.model) ?? models.find((m) => m.isDefault);
  if (!h || !fixed || !model?.efforts.length) return null;
  const value = fixed.effort && model.efforts.includes(fixed.effort) ? fixed.effort : (model.defaultEffort ?? model.efforts[0]);
  return (
    <Row title="Thinking effort" desc="The effort new chats start with on the default model.">
      <Select
        value={value}
        width={220}
        options={model.efforts.map((e) => ({ value: e, label: effortLabel(e) }))}
        onChange={(e) => setNewChatDefault(h, fixed.model ?? model.id, e)}
      />
    </Row>
  );
}

/** "New chats use", then whether new chats follow the last used, atop All harnesses; the note says what runs while the default can't. */
export function NewChatsUse({ ids }: { ids: readonly HarnessId[] }) {
  // the saved default's own note: the open draft's pick is not what this page sets
  const note = useStore((s) => defaultHarnessNote(savedDefaultResolved(s)));
  return (
    <Group>
      <Row title="New chats use" desc={note ?? 'Only harnesses that are ready are listed.'}>
        <DefaultHarnessSelect ids={ids} />
      </Row>
      <NewChatStartRow />
      <DefaultEffortRow />
      <HighestCliVersion />
    </Group>
  );
}

function HighestCliVersion() {
  const title = 'Use highest installed CLI version';
  const on = useStore((s) => s.prefs.preferHighestCli === true);
  const save = async (value: boolean) => {
    try {
      if (!(await native.prefs.patch({ preferHighestCli: value }, []))) throw new Error('The change was refused.');
    } catch (error) {
      toastFailure("Couldn't save CLI version selection")(error);
    }
  };
  return (
    <Row
      title={title}
      desc="Check all detected copies on this computer, including prereleases. A custom path takes priority. Applies after restarting MoPilot."
    >
      <Toggle label={title} on={on} onChange={save} />
    </Row>
  );
}

/** What new chats use, every harness, one row each, and the way to accounts. */
export function AllHarnesses({ ids }: { ids: readonly HarnessId[] }) {
  // a harness installed since the list was read shows up when the page opens
  useFreshBasics();
  // the store's own list, filtered here: a selector returning a new array would re-render without end
  const basics = installedBasics(useStore((s) => s.basicHarnesses));
  // one that isn't installed is offered under Install another harness, as a basic one is
  const status = useFirstClassStatus();
  const installed = ids.filter((h) => harnessPhase(status[h]) !== 'missing');
  return (
    <>
      <NewChatsUse ids={ids} />
      <section className="settings-group">
        <HarnessUpdatesBanner />
        <div className="settings-card hrows">
          {installed.map((h) => (
            <Fragment key={h}>
              <HarnessRow h={h} />
              <RouteNotice harness={h} label={HARNESS_LABEL[h]} />
            </Fragment>
          ))}
          {basics.map((b) => (
            <Fragment key={b.id}>
              <BasicRow b={b} />
              <RouteNotice harness={`acp:${b.id}`} label={b.label} />
            </Fragment>
          ))}
          <div className="hrows-foot">
            <span>Accounts, API keys and credits are managed in one place.</span>
            <button type="button" className="btn-pill" onClick={() => navigate({ name: 'settings', section: 'accounts' })}>
              Accounts & billing
            </button>
          </div>
        </div>
        <HarnessUpdatesFoot />
      </section>
    </>
  );
}
