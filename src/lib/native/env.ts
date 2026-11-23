// window.native.env's types (environment setup scripts), merged into NativeApi; the calls are declared in electron/bridge/env.cjs.
import type { ResolvedEnvironment } from '../environments';

declare module '../native' {
  interface NativeApi {
    env: {
      /** Run a setup or cleanup script in the login shell (through a pty). */
      runScript(cwd: string, script: string): Promise<{ exitCode: number; output: string }>;
      /** Write <root>/.codex/environments/environment.toml. */
      write(root: string, text: string): Promise<{ ok: boolean; error?: string }>;
      /** Where the project's environment config comes from and what it says (electron/platform/environmentSource.cjs). */
      resolve(root: string): Promise<ResolvedEnvironment>;
      /** Write environment.toml from the project's Conductor config; refused when one exists. */
      convert(root: string): Promise<{ ok: boolean; file?: string; error?: string }>;
    };
  }
}
