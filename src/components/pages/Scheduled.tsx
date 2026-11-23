// Scheduled-page routing, task creation templates and scheduler availability notice.
import { useEffect, useRef } from 'react';
import { canonicalTask } from '../../../shared/scheduleTask.mjs';
import { useStore, toast, setPrefs } from '../../store/core';
import { chatKind } from '../../store/chats';
import { saveEditedAutomation, type Automation } from '../../lib/automations';
import { errorText } from '../../lib/ignored';
import { useSched, reload, blank } from './scheduled/state';
import { TaskDetail } from './scheduled/TaskDetail';
import { ScheduleDialog } from './scheduled/ScheduleDialog';
export { ScheduledNav } from './scheduled/ScheduledNav';

const TEMPLATES: { emoji: string; name: string; desc: string; prompt: string; rule: string }[] = [
  {
    emoji: '☀️',
    name: 'News updates',
    desc: 'Send me a daily roundup of news on topics I care about.',
    prompt: 'Search the web for today’s most important news on the topics I care about and send me a short roundup with links.',
    rule: 'FREQ=DAILY;BYHOUR=8;BYMINUTE=0',
  },
  {
    emoji: '✉️',
    name: 'Email monitor',
    desc: 'Scan my emails and let me know anything that needs my attention.',
    prompt: 'Scan my recent email and tell me about anything that needs my attention or a reply, most urgent first.',
    rule: 'FREQ=DAILY;BYHOUR=9;BYMINUTE=0',
  },
  {
    emoji: '🤖',
    name: 'Generative retrieval and agent research',
    desc: 'Send me the most worthwhile new papers and reports every Friday',
    prompt:
      'Find the most worthwhile new papers and reports from this week on generative retrieval and AI agents. Summarize each in two sentences with a link.',
    rule: 'FREQ=WEEKLY;BYDAY=FR;BYHOUR=9;BYMINUTE=0',
  },
  {
    emoji: '💰',
    name: 'Weekly finances update',
    desc: 'Review my recent spending, and anything that needs attention.',
    prompt: 'Review my recent spending and flag anything unusual or that needs attention this week.',
    rule: 'FREQ=WEEKLY;BYDAY=MO;BYHOUR=9;BYMINUTE=0',
  },
  {
    emoji: '😴',
    name: 'Sleep coaching',
    desc: 'Track my sleep quality and help me improve my habits.',
    prompt: 'Check in on how I slept, track the trend over time, and suggest one small habit to improve my sleep.',
    rule: 'FREQ=DAILY;BYHOUR=8;BYMINUTE=30',
  },
  {
    emoji: '🥗',
    name: 'Weekly meal plan',
    desc: 'Plan meals for the week and make a grocery list.',
    prompt: 'Plan healthy meals for the coming week and make a grocery list grouped by store section.',
    rule: 'FREQ=WEEKLY;BYDAY=SU;BYHOUR=10;BYMINUTE=0',
  },
];
export function Scheduled() {
  const { list, selected, editing } = useSched();
  const owner = useRef({ mounted: false, opening: 0, save: 0 });
  useEffect(() => {
    const current = owner.current;
    current.mounted = true;
    const off = useSched.subscribe((next, previous) => {
      if (next.editing !== previous.editing || next.selected !== previous.selected) {
        current.opening++;
        current.save++;
      }
    });
    return () => {
      current.mounted = false;
      current.save++;
      off();
    };
  }, []);
  useEffect(() => {
    const h = (e: Event) => {
      const d = (e as CustomEvent).detail;
      useSched.setState({
        editing: blank({
          kind: 'heartbeat',
          name: d.name ?? '',
          cwds: [d.cwd],
          target_thread_id: d.threadId,
          // a run continues that chat, so it runs with the chat's own harness, not the default for new chats
          ...(d.threadId ? { harness: chatKind(d.threadId) } : {}),
        }),
        selected: null,
      });
    };
    window.addEventListener('new-scheduled-task', h);
    return () => window.removeEventListener('new-scheduled-task', h);
  }, []);
  let task: Automation | null = null;
  let selectionError = '';
  try {
    if (list && selected !== null) task = canonicalTask(list, selected);
  } catch (error) {
    selectionError = errorText(error);
  }

  /** `initial`: the task the dialog opened with. */
  const save = async (initial: Automation, a: Automation) => {
    const current = owner.current;
    const request = ++current.save;
    const ownsEditor = () => current.mounted && current.save === request;
    try {
      const saved = await saveEditedAutomation(initial, a);
      // Accepted writes and the shared list refresh outlive their editor opening.
      await reload();
      if (!ownsEditor()) return;
      useSched.setState({ editing: null, selected: saved.id });
      toast('Scheduled task saved');
    } catch (e) {
      if (!ownsEditor()) return;
      toast(`Couldn't save the task: ${errorText(e)}`, 'error');
    }
  };

  return (
    <div className="page sched-page">
      {editing && (
        <ScheduleDialog
          key={owner.current.opening}
          initial={editing}
          onCancel={() => useSched.setState({ editing: null })}
          onSave={(a) => save(editing, a)}
        />
      )}
      {selectionError ? (
        <div className="notice" role="alert">
          {selectionError}
        </div>
      ) : task ? (
        <TaskDetail key={task.id} a={task} />
      ) : (
        <div className="sched-empty">
          <span className="sched-empty-icon" role="img" aria-label="🕗">
            🕗
          </span>
          <div className="sched-empty-title">Schedule a task</div>
          <div className="sched-empty-sub">Codex, Claude Code or another harness can take care of ongoing tasks so you don't have to.</div>
          <div className="sched-templates">
            {TEMPLATES.map((t) => (
              <button
                key={t.name}
                className="sched-template"
                onClick={() => useSched.setState({ editing: blank({ name: t.name, prompt: t.prompt, rrule: t.rule }) })}
              >
                <span className="sched-template-emoji">{t.emoji}</span>
                <span className="sched-template-text">
                  <span className="sched-template-name">{t.name}</span>
                  <span className="sched-template-desc">{t.desc}</span>
                </span>
              </button>
            ))}
          </div>
          <SchedulerNotice />
        </div>
      )}
    </div>
  );
}
function SchedulerNotice() {
  const enabled = !useStore((s) => s.prefs.schedulerOff);
  return (
    <div className="notice sched-notice">
      <span>
        {enabled
          ? 'Scheduled tasks run while MoPilot is open, even with no window. Each time runs once.'
          : 'The scheduler is off. Tasks run only while the Codex app or Claude Desktop is open.'}
      </span>
      <button className="btn-pill" onClick={() => setPrefs({ schedulerOff: enabled })}>
        {enabled ? 'Turn off' : 'Turn on'}
      </button>
    </div>
  );
}
