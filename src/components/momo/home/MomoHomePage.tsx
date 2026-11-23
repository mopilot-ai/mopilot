// MoMo's page when the home answers: setup until it is done, then the header (tabs and the "Runs on" pill), the home's banners and the tab the route names. Each part reads only its slice of the one view, so a change to one task redraws that task.
import { useState } from 'react';
import { navigate } from '../../../store/panes';
import type { MomoTab } from '../MomoNav';
import { ChatView } from './ChatView';
import { HomeBanner, ProblemBanners } from './HomeBanner';
import { NotesView } from './NotesView';
import { RulesView } from './RulesView';
import { SetupFlow } from './SetupFlow';
import { TasksView } from './TasksView';
import { WhereRuns } from './WhereRuns';
import type { MomoView } from '../../../../shared/momoView';
import { setHomeNotice, useHomeNotice } from './homeNotice';
import { useStaleNote } from './staleNote';
import { useMomoSelect } from './useMomoHome';
import styles from './home.module.css';

const TABS = [
  ['chat', 'Chat'],
  ['tasks', 'Tasks'],
  ['notes', 'Notes'],
  ['rules', 'Rules'],
] as const;

/** A slice of the view for a part that is only drawn once the view is there (the page below returns before it otherwise). */
function usePart<T>(select: (v: MomoView) => T): T {
  return useMomoSelect(select) as T;
}

function Header({ shown }: { shown: string }) {
  const home = usePart((v) => v.home);
  const [where, setWhere] = useState(false);
  const problems = usePart((v) => v.problems);
  const stale = useStaleNote();
  const notice = useHomeNotice();
  return (
    <>
      <div className={styles.top}>
        <span className={styles.name}>MoMo</span>
        <nav aria-label="MoMo views">
          {TABS.map(([id, label]) => (
            <button
              key={id}
              type="button"
              className={styles.tab}
              aria-current={id === shown ? 'page' : undefined}
              onClick={() => navigate({ name: 'momo', tab: id })}
            >
              {label}
            </button>
          ))}
        </nav>
        <WhereRuns home={home} open={where} onOpen={setWhere} />
      </div>
      <div className={styles.body} style={{ paddingBottom: 0, flex: 'none' }}>
        <div className={styles.column}>
          {stale ? (
            <p className={styles.meta} role="status">
              MoMo runs on {stale} now.
            </p>
          ) : null}
          {notice ? (
            <p className={styles.meta} role="status">
              {notice}{' '}
              <button type="button" className={styles.btn} onClick={() => setHomeNotice(null)}>
                Got it
              </button>
            </p>
          ) : null}
          <HomeBanner home={home} onMove={() => setWhere(true)} />
          <ProblemBanners problems={problems} />
        </div>
      </div>
    </>
  );
}

function ChatPart({ now }: { now?: number }) {
  const chat = usePart((v) => v.chat);
  const name = usePart((v) => v.home.machineName);
  const state = usePart((v) => v.home.state);
  return <ChatView chat={chat} name={name} asleep={state === 'asleep'} now={now} />;
}

function TasksPart({ now }: { now?: number }) {
  const tasks = usePart((v) => v.tasks);
  const machines = usePart((v) => v.home.machines);
  return <TasksView tasks={tasks} machines={machines} now={now} />;
}

function NotesPart() {
  const notes = usePart((v) => v.notes);
  const sources = usePart((v) => v.home.sources);
  return <NotesView notes={notes} sources={sources} />;
}

function RulesPart() {
  const rules = usePart((v) => v.rules);
  const signals = usePart((v) => v.signals);
  const settings = usePart((v) => v.settings);
  return <RulesView rules={rules} signals={signals} settings={settings} />;
}

/** The tab the route names; each reads only its own slices, so a change to another tab's data redraws nothing here. */
function Tab({ shown, now }: { shown: string; now?: number }) {
  if (shown === 'chat') return <ChatPart now={now} />;
  if (shown === 'tasks') return <TasksPart now={now} />;
  if (shown === 'notes') return <NotesPart />;
  return <RulesPart />;
}

export function MomoHomePage({ tab = 'chat', now }: { tab?: MomoTab; now?: number }) {
  const setup = useMomoSelect((v) => v.setup);
  const machines = useMomoSelect((v) => v.home.machines);
  const homeName = useMomoSelect((v) => v.home.machineName);
  const settings = useMomoSelect((v) => v.settings);
  const home = useMomoSelect((v) => v.home);
  if (!setup || !machines || !settings || !home) return null;
  // this machine is no longer where MoMo lives: that, and nothing else, is the page (the home has no first-run for it to pick)
  if (home.movedAway)
    return (
      <div className={styles.frame} data-momo-home>
        <div className={styles.body}>
          <div className={styles.column}>
            <HomeBanner home={home} />
          </div>
        </div>
      </div>
    );
  // a setup step this client does not know is past setup: the page, not a dead end
  if (setup.step === 'where' || setup.step === 'read' || setup.step === 'reach')
    return (
      <div className={styles.frame}>
        <SetupFlow setup={setup} machines={machines} homeName={homeName} settings={settings} />
      </div>
    );
  const shown = tab === 'memory' ? 'chat' : tab;
  return (
    <div className={styles.frame} data-momo-home>
      <Header shown={shown} />
      <Tab shown={shown} now={now} />
    </div>
  );
}
