// window.native.exitGate's types (the quit and update confirmation), merged into NativeApi; the calls are declared in electron/bridge/exitGate.cjs.
import type { ExitGateRequest } from '../native';

declare module '../native' {
  interface NativeApi {
    exitGate: {
      onConfirm(cb: (id: number, req: ExitGateRequest) => void): () => void;
      answer(id: number, ok: boolean | 'stop'): void;
    };
  }
}
