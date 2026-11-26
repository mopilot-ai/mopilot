// Settings → General: chat defaults, notifications, folders and the "open in" destination.

import { Group, Row, Toggle, Select, Segmented } from './Controls';
import { isMac } from '../../../lib/platform';
import { composerSendShortcuts } from '../../../lib/composerSendKeys';
import { useEffect, useState } from 'react';
import { useStore, setPrefs, toast, toastFailure } from '../../../store/core';
import { projectlessFolderOf } from '../../../store/types';
import { AutoArchiveRow } from './AutoArchiveRow';
import { LanguageRow } from './LanguageRow';
import { TimeInput } from '../../momo/settings/Proactivity';
import { autoApplyReviewFixes } from '../../../../shared/reviewAutoFix.mjs';
import { resumeAfterQuotaReset, switchHarnessAtLimit } from '../../../../shared/limitPolicy.mjs';
import { native } from '../../../lib/native';
import { shortPath } from './Rows';
import type { Automation } from '../../../lib/automations';
import { APP_LABEL, appStatusRows } from '../../../lib/scheduleTask';
import { useAutomationApps } from '../automationApps';
import { createLatestLoader } from '../../../lib/latestLoader';
import { availableOpenApps, type OpenApp } from '../../../lib/openApps';
import { AppIcon, useInstalledApps } from '../../titleBar/OpenInApps';
import { PUSH_OPT_IN_KINDS, pushesToPhone } from '../../../../shared/remote/pushSettings.mjs';

/** One switch per notification kind (electron/platform/notify.cjs KINDS), inside the Notifications row. */
const NOTIFY_KINDS: { kind: 'turn' | 'approval' | 'scheduled' | 'goal' | 'auth' | 'computer'; label: string }[] = [
  { kind: 'turn', label: 'Task finished' },
  { kind: 'approval', label: 'Approval needed' },
  { kind: 'goal', label: 'Goal updates' },
  { kind: 'scheduled', label: 'Scheduled task started' },
  { kind: 'auth', label: 'Sign-in needed' },
  { kind: 'computer', label: 'Computer use' },
];

/** Scheduled tasks: the scheduler, the other apps that run tasks and what they are doing, and missed times. */
function ScheduledTasks() {
  const off = useStore((s) => s.prefs.schedulerOff);
  const apps = useAutomationApps();
  const [tasks, setTasks] = useState<Automation[]>([]);
  useEffect(() => {
    // a task that didn't load is the Scheduled page's to report
    const loader = createLatestLoader(
      () => native.automation.list(),
      (r) => setTasks(r.tasks),
    );
    void loader.load();
    const stop = native.automation.onChanged(() => void loader.load());
    return () => {
      loader.stop();
      stop();
    };
  }, []);
  const rows = appStatusRows(apps, tasks, !off);
  return (
    <Group title="Scheduled tasks">
      <Row
        title="Run scheduled tasks"
        desc="While MoPilot is open, even with no window. Each scheduled time runs once, here or in an app below that is open. A time missed while nothing was open runs once when MoPilot opens or the computer wakes, within 7 days, as in the Codex app and Claude Desktop."
      >
        <Toggle on={!off} onChange={(v) => setPrefs({ schedulerOff: !v })} />
      </Row>
      {rows.length > 0 && (
        <div className="settings-row sched-apps-row">
          <div className="settings-row-text">
            <div className="settings-row-title">Other apps that run these tasks</div>
            <div className="settings-row-desc">
              An open app runs its own tasks. When it's closed, MoPilot runs them and records each run in that app, so it doesn't run them
              again.
            </div>
            <div className="sched-app-status">
              {rows.map((r) => (
                <div key={r.app} className="sched-app-status-row">
                  <span className={`sched-app-dot ${r.app}`} aria-hidden="true" />
                  <span className="sched-app-status-name">{APP_LABEL[r.app]}</span>
                  <span className={`sched-run-status ${r.open ? 'ran' : ''}`}>{r.open ? 'Open' : 'Closed'}</span>
                  <span className="sched-app-status-detail">{r.detail}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </Group>
  );
}

/* ------------------------------------------------------------------ */
/* General                                                             */
/* ------------------------------------------------------------------ */

export function General() {
  const prefs = useStore((s) => s.prefs);
  const home = useStore((s) => s.home);
  const projectless = projectlessFolderOf(prefs, home);
  const sendKeys = composerSendShortcuts(prefs.sendWith);
  return (
    <>
      <Group title="Permissions">
        <Row title="Default permissions" desc="Allow workspace changes. Additional access requires approval.">
          <Toggle
            on={prefs.permission !== 'read-only'}
            disabled={prefs.permission === 'full-access'}
            onChange={(v) => setPrefs({ permission: v ? 'default' : 'read-only' })}
          />
        </Row>
        <Row title="Full access" desc="Allows changes to any file and network commands without approval.">
          <Toggle on={prefs.permission === 'full-access'} onChange={(v) => setPrefs({ permission: v ? 'full-access' : 'default' })} />
        </Row>
      </Group>
      <Group title="General">
        <LanguageRow />
        <Row title="Task folder" desc="For chats outside projects.">
          <span className="settings-path">{shortPath(projectless)}</span>
          <button
            className="btn-pill soft"
            onClick={async () => {
              const p = await native.dialog.openFolder();
              if (p) setPrefs({ projectlessFolder: p });
            }}
          >
            Change
          </button>
        </Row>
        <Row title="Open files in">
          <OpenDestinationSelect />
        </Row>
        <Row title="Show in menu bar" desc="Keeps MoPilot running with every window closed, so scheduled tasks keep running.">
          <Toggle
            on={prefs.showInMenuBar}
            onChange={(v) => {
              // the setting changes once main has shown or removed the menu bar item
              return native.app
                .setTray(v)
                .then(
                  () => setPrefs({ showInMenuBar: v }),
                  toastFailure(v ? "Couldn't show MoPilot in the menu bar" : "Couldn't remove it from the menu bar"),
                );
            }}
          />
        </Row>
        <Row title="Confirm before quitting" desc="Ask before stopping running work.">
          <Select
            value={prefs.confirmClose}
            options={[
              { value: 'shortcut', label: 'When work is running' },
              { value: 'always', label: 'Always' },
              { value: 'never', label: 'Never' },
            ]}
            onChange={(v) => setPrefs({ confirmClose: v })}
          />
        </Row>
        <Row title="Expand panels" desc="Open tool panels expanded.">
          <Toggle on={prefs.fullViewDefault} onChange={(v) => setPrefs({ fullViewDefault: v })} />
        </Row>
        <Row title="Show panel button">
          <Toggle on={prefs.bottomPanelControl} onChange={(v) => setPrefs({ bottomPanelControl: v })} />
        </Row>
        <Row title="iOS Simulator" desc="Let chats run and drive apps in the iOS Simulator.">
          <Toggle on={prefs.simulatorIos} onChange={(v) => setPrefs({ simulatorIos: v })} />
        </Row>
        <Row title="Android Emulator" desc="Let chats run and drive apps in the Android Emulator.">
          <Toggle on={prefs.simulatorAndroid} onChange={(v) => setPrefs({ simulatorAndroid: v })} />
        </Row>
        <Row title="Terminal position">
          <Segmented
            value={prefs.defaultTerminal}
            options={[
              { value: 'bottom', label: 'Bottom' },
              { value: 'right', label: 'Right' },
            ]}
            onChange={(v) => setPrefs({ defaultTerminal: v })}
          />
        </Row>
      </Group>
      <ScheduledTasks />
      <Group title="Chats">
        <Row title="Send with">
          <Select
            value={prefs.sendWith}
            options={[
              { value: 'enter', label: 'Enter' },
              { value: 'cmdEnter', label: isMac ? '⌘ Enter' : 'Ctrl+Enter' },
            ]}
            onChange={(v) => setPrefs({ sendWith: v })}
          />
        </Row>
        <Row title="When you ask for an unrelated task" desc="Whether it runs in a new session or in this chat.">
          <Select
            value={prefs.newTaskPrompt}
            options={[
              { value: 'ask', label: 'Ask me' },
              { value: 'here', label: 'Always do it here' },
              { value: 'new', label: 'Always start a new session' },
            ]}
            onChange={(v) => setPrefs({ newTaskPrompt: v })}
          />
        </Row>
        <AutoArchiveRow />
        <Row
          title="Apply code review fixes automatically"
          desc="When a code review ends with findings, the chat starts fixing them. A chat whose pull request has Auto-fix on always does."
        >
          <Toggle on={autoApplyReviewFixes(prefs)} onChange={(v) => setPrefs({ autoApplyReviewFixes: v })} />
        </Row>
        <Row title="Resume after quota resets" desc="Automatically continue the chat on the same harness when its quota resets.">
          <Toggle on={resumeAfterQuotaReset(prefs)} onChange={(v) => setPrefs({ autoContinueOnLimit: v })} />
        </Row>
        <Row
          title="Switch harness at a usage limit"
          desc="Automatically continue on another available harness when all accounts on the current harness run out of quota."
        >
          <Toggle on={switchHarnessAtLimit(prefs)} onChange={(v) => setPrefs({ autoSwitchHarnessOnLimit: v })} />
        </Row>
        <Row
          title="Follow-up behavior"
          desc={`What the Send button and ${sendKeys.submit} do while the agent is working. ${sendKeys.alternate} does the other one.`}
        >
          <Segmented
            value={prefs.followUp}
            options={[
              { value: 'queue', label: 'Queue' },
              { value: 'steer', label: 'Steer' },
            ]}
            onChange={(v) => setPrefs({ followUp: v })}
          />
        </Row>
        <Row
          title="Notifications"
          desc={
            <>
              Get a system notification when a task finishes or needs you
              <span className="notify-kinds">
                {NOTIFY_KINDS.map((k) => (
                  <label key={k.kind} className="notify-kind">
                    <Toggle
                      on={prefs.notifyKinds?.[k.kind] !== false}
                      disabled={prefs.notifyOnComplete === 'never'}
                      onChange={(v) => setPrefs({ notifyKinds: { ...prefs.notifyKinds, [k.kind]: v } })}
                    />
                    {k.label}
                    {PUSH_OPT_IN_KINDS.includes(k.kind) && (
                      <span className="notify-phone">{pushesToPhone(prefs.notifyKinds, k.kind) ? 'Phone on' : 'Phone off'}</span>
                    )}
                  </label>
                ))}
              </span>
            </>
          }
        >
          <Select
            value={prefs.notifyOnComplete}
            options={[
              { value: 'unfocused', label: 'When unfocused' },
              { value: 'needed', label: "Only when I'm needed" },
              { value: 'always', label: 'Always' },
              { value: 'never', label: 'Never' },
            ]}
            onChange={(v) => setPrefs({ notifyOnComplete: v })}
          />
        </Row>
        <NotificationQuietHours />
        <Row title="Show reasoning">
          <Toggle on={prefs.showReasoning} onChange={(v) => setPrefs({ showReasoning: v })} />
        </Row>
      </Group>
    </>
  );
}

/** The usual quiet hours when they are switched on. */
const QUIET_DEFAULT = { start: '22:00', end: '07:00' };

/** Quiet hours for notifications (prefs.notifyQuietHours): none show or push while they last; a chat that needs you is sent to a paired phone once when they end. */
function NotificationQuietHours() {
  const q = useStore((s) => s.prefs.notifyQuietHours);
  // start and end can't be the same time: that change is not saved
  const commit = (part: 'start' | 'end', v: string) => {
    const next = { ...q!, [part]: v };
    if (next.start === next.end) {
      toast("Quiet hours can't start and end at the same time", 'error');
      return false;
    }
    setPrefs({ notifyQuietHours: next });
    return true;
  };
  return (
    <Row
      title="Notification quiet hours"
      desc={q ? 'Nothing notifies between these times. Your phone hears once when they end if a chat needed you.' : 'Off'}
    >
      {q && (
        <>
          <TimeInput label="Notification quiet hours start" value={q.start} onCommit={(v) => commit('start', v)} />
          <span className="momo-time-sep">–</span>
          <TimeInput label="Notification quiet hours end" value={q.end} onCommit={(v) => commit('end', v)} />
        </>
      )}
      <Toggle on={!!q} onChange={(on) => setPrefs({ notifyQuietHours: on ? { ...QUIET_DEFAULT } : null })} />
    </Row>
  );
}

/** Only apps that are installed, each with its real icon. */
function OpenDestinationSelect() {
  const prefs = useStore((s) => s.prefs);
  const installed = useInstalledApps();
  return (
    <Select
      value={prefs.openDestination}
      icon={<AppIcon id={prefs.openDestination} />}
      options={availableOpenApps(installed, prefs.openDestination)}
      onChange={(v) => setPrefs({ openDestination: v as OpenApp })}
    />
  );
}
