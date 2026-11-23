export const MAX_TEXT: number;
export const INSTALL_WORDS: Readonly<{
  install: (name: string) => string;
  installing: string;
  cancel: string;
  retry: string;
  done: string;
  lost: string;
  failed: string;
  tooLong: string;
  oldHost: string;
}>;
export type InstallAction = 'retry' | 'cancel';
export type InstallStatus = { text: string; action?: InstallAction; details?: string };
export function installText(v: unknown): string;
export function installLine(view: { state: string; harness: string; error?: string | null } | undefined): string;
export function installStatus(
  view: { state: string; harness: string; error: string | null; line?: string } | undefined,
): InstallStatus | null;
