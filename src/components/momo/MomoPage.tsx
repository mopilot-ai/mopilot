// MoMo's page (#2139, the shell M0b): setup until it is finished or skipped, then the tab its route names (the sidebar column's MomoNav moves between them): Chat full height, as Muse's chat, and Memory under its own title. App loads this module only for an invited account.
import { useMomoPrefs } from '../../session/momoPrefs';
import { MomoSetup } from './setup/MomoSetup';
import { MomoChatTab } from './MomoChatTab';
import { MemoryTab } from './MemoryTab';
import { TasksTab } from './TasksTab';
import { TasksPanel } from './tasks/TasksPanel';
import { ChannelledChat, ChannelledPage } from './channels/ChannelledChat';
import { MomoHomePage } from './home/MomoHomePage';
import { useMomoHomeStatus } from './home/useMomoHome';
import type { MomoTab } from './MomoNav';
import styles from './momoPage.module.css';

export default function MomoPage({ tab = 'chat', chatId }: { tab?: MomoTab; chatId?: string }) {
  // until setup is finished or skipped, it is the page
  const prefs = useMomoPrefs();
  // once MoMo's home answers, its surfaces draw every tab from the home's one view; until it does (no home composed, an older preload, the dev switch off) the pages below are the page
  const home = useMomoHomeStatus();
  if (home.status === 'ready') return <MomoHomePage tab={tab} />;
  if (!prefs.onboarding.done) return <MomoSetup />;
  // `momo.shell` off draws today's page, the chat alone; on, the chat sits in the shell (rail, panel buttons, one panel at a time)
  if (tab === 'chat') {
    // with the shell on, channels (A2) add their rail, header and Everything where `momo.channels` is on
    if (prefs.shell) return <ChannelledChat chatId={chatId} on={prefs.channels} />;
    return <MomoChatTab key={chatId ?? 'main'} chatId={chatId} shell={false} />;
  }
  const page = (
    <div className={styles.page}>
      <div className={styles.column}>
        <h1 className={styles.title}>{tab === 'tasks' ? 'Tasks' : 'Memory'}</h1>
        {tab === 'tasks' ? prefs.tasksPanel ? <TasksPanel /> : <TasksTab /> : <MemoryTab />}
      </div>
    </div>
  );
  // with the shell on, its rail is the one navigation column on every page of MoMo
  return prefs.shell ? (
    <ChannelledPage tab={tab} on={prefs.channels}>
      {page}
    </ChannelledPage>
  ) : (
    page
  );
}
