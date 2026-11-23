// window.native.cloud's types (Codex Cloud tasks), merged into NativeApi; the calls are declared in electron/bridge/cloud.cjs.
import type { CloudEnv, CloudTask } from '../native';

declare module '../native' {
  interface NativeApi {
    cloud: {
      envs(): Promise<{ envs?: CloudEnv[]; error?: string }>;
      exec(
        env: string,
        prompt: string,
        attempts?: number,
        claim?: { repository: string; account: string | null },
      ): Promise<{ ok: boolean; id: string | null; output: string }>;
      list(env?: string): Promise<{ tasks: CloudTask[]; cursor?: string | null; error?: string }>;
      status(id: string): Promise<{ ok: boolean; text: string }>;
      diff(id: string, attempt?: number): Promise<{ ok: boolean; diff: string; error: string | null }>;
      apply(id: string, cwd: string, attempt?: number): Promise<{ ok: boolean; output: string }>;
    };
  }
}
