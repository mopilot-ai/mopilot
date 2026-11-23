// window.native.momoBrief's types (the morning brief's Try again, A7), merged into NativeApi; the call is declared in electron/bridge/momoBrief.cjs.
import type { MomoTasksResult } from './contracts/momoTasks';

declare module '../native' {
  interface NativeApi {
    momoBrief: {
      /** write the brief now (`reason: 'skipped'` when there is nothing to send, with the words in `error`) */
      runNow(): Promise<MomoTasksResult>;
    };
  }
}
