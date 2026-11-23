// Fake xterm terminal behavior and event handles for terminal-panel UI unit tests.
export const terminalCalls: unknown[][] = [];
export const terminalInstances: FakeTerminal[] = [];
export class FakeTerminal {
  attachCustomKeyEventHandler(callback: (event: KeyboardEvent) => boolean) {
    this.keyHandler = callback;
  }
  keyHandler?: (event: KeyboardEvent) => boolean;
  clear() {
    terminalCalls.push(['clear']);
  }
  cols = 80;
  rows = 24;
  options: any;
  written: string[] = [];
  disposed = false;
  focused = 0;
  data?: (d: string) => void;
  resize?: (r: { rows: number; cols: number }) => void;
  constructor(options: any) {
    this.options = options;
    terminalInstances.push(this);
  }
  loadAddon() {}
  open(el: HTMLElement) {
    terminalCalls.push(['open', el.className]);
  }
  write(s: string) {
    this.written.push(s);
  }
  focus() {
    this.focused++;
  }
  onData(cb: (d: string) => void) {
    this.data = cb;
    return { dispose: () => terminalCalls.push(['dispose data']) };
  }
  onResize(cb: (r: { rows: number; cols: number }) => void) {
    this.resize = cb;
    return { dispose: () => terminalCalls.push(['dispose resize']) };
  }
  dispose() {
    this.disposed = true;
  }
}
