// window.native.momoTasks's types (MoMo's Tasks tab, A1), merged into NativeApi; the calls are declared in electron/bridge/momoTasks.cjs.
import type { MomoTasksResult, MomoTask, MomoPanelTask, MomoTaskMark } from './contracts/momoTasks';

declare module '../native' {
  interface NativeApi {
    momoTasks: {
      /** every task, the ones that need the user first */
      list(): Promise<
        MomoTasksResult<{ v?: undefined; tasks: MomoTask[]; now: number } | { v: 2; tasks: MomoPanelTask[]; paused: boolean; now: number }>
      >;
      /** the user's mark on a run; with `undoToken` it takes back what that call did (`reason: 'expired'` when it no longer can) */
      mark(
        taskId: string,
        mark: MomoTaskMark,
        undoToken?: string,
      ): Promise<MomoTasksResult<{ taskId: string; mark: 'done' | 'archived' | 'deleted' | null; undoToken?: string }>>;
      onChanged(cb: () => void): () => void;
    };
  }
}
