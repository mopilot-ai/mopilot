// Where a component notes something for the always-on renderer record (src/session/rendererRecord.ts): nothing happens when no record is installed.

export type BusyWhy = 'locked' | 'preparing' | 'starting';
/** One content-free line: what happened and numbers or short words about it, never text, ids or paths. */
export type RendererRecord = {
  what: 'longtask' | 'slowInput' | 'composerRefused' | 'composerComposition' | 'composerBusyReleased';
  ms?: number;
  delay?: number;
  processing?: number;
  rows?: number;
  messages?: number;
  count?: number;
  route?: string;
  name?: string;
  inputType?: string;
  why?: BusyWhy;
  focused?: boolean;
  visible?: boolean;
};

let sink: ((line: RendererRecord) => void) | null = null;

/** The record installed in this window takes what is noted; null takes it away. */
export function setRendererSink(next: ((line: RendererRecord) => void) | null) {
  sink = next;
}

/** Notes one line for the record; dropped when there is none (tests, tooling). */
export function noteRenderer(line: RendererRecord) {
  sink?.(line);
}
