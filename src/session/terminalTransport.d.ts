// What a terminal view runs on: its tab, and the transport that starts (or joins) the process behind it and carries its
// input, size and output. The terminal panel draws it; a harness CLI's run (session/harness/harnessRuns.ts) provides one.

export interface Tab {
  id: string;
  cwd: string;
  command?: string[];
  windowsCommandLine?: string;
  env?: Record<string, string | null>;
  input?: string;
  /** a sign-in command: its URLs open in the user's own browser */
  signIn?: boolean;
  title: string;
  /** the machine and folder a chat's shell on a machine runs in (src/lib/machineShell.ts) */
  where?: string;
  exited?: number;
}

/** What a terminal view hears from the process behind it. */
export type TermEvents = { data(d: string): void; exit(code: number): void; error(message: string): void };
/** The process behind a terminal view: what it types and its size go there, and close ends the view's part in it. */
export type TermIo = { write(d: string): void; resize(cols: number, rows: number): void; close(): void };
/** Starts (or joins) the process for `tab` at the view's first size. */
export type TermTransport = (tab: Tab, size: { cols: number; rows: number }, on: TermEvents) => TermIo;
