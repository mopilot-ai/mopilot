// window.native.automation's types (scheduled tasks), merged into NativeApi; the calls are declared in electron/bridge/automation.cjs.
import type { Automation, AutomationApps, AutomationRun } from '../automations';

declare module '../native' {
  interface NativeApi {
    automation: {
      /** "Run now": resolves to the chat the run is in; rejects with why it could not start */
      run(automation: Automation): Promise<string>;
      /** every task, wherever its harness keeps it, and the files that didn't load */
      list(): Promise<{ tasks: Automation[]; errors: string[] }>;
      /** save where the task's harness keeps it (a new task gets an id): the task as listed */
      save(automation: Automation): Promise<Automation>;
      /** patch current task fields atomically; reject a missing or unreadable task */
      update(id: string, changes: Partial<Automation>): Promise<Automation>;
      remove(id: string): Promise<void>;
      /** the task's scheduled times and what happened at each, newest first */
      runs(id: string): Promise<AutomationRun[]>;
      /** whether the scheduler is on, and whether each native app that runs tasks is installed and open */
      apps(): Promise<AutomationApps>;
      /** a task changed (here, in another window, or by a chat's tool): `chatId` names the chat that changed it */
      onChanged(cb: (e: { id?: string; action?: string; chatId?: string }) => void): () => void;
    };
  }
}
