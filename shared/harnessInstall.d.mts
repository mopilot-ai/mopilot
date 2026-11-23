// Types for the shared harness install table (harnessInstall.mjs).
export type InstallVia = 'script' | 'brew' | 'npm' | 'winget' | 'powershell';
export type InstallOs = 'darwin' | 'linux' | 'win32';

export interface InstallMethod {
  via: InstallVia;
  /** exactly what the vendor's docs say */
  command: string;
  os: InstallOs[];
  /** a tool it runs through, checked against what is on PATH */
  needs?: 'node' | 'brew';
  /** the npm package it installs */
  npm?: string;
  /** the Homebrew formula or cask it installs */
  brew?: { name: string; cask: boolean };
  /** shown beside the line ("Needs Git for Windows") */
  note?: string;
}

export interface HarnessInstallInfo {
  methods: InstallMethod[];
  /** the vendor's setup page */
  docs: string;
}

/** What main found on the login-shell PATH; npmWritable is null when there is no npm to ask. */
export interface InstallTools {
  npm: boolean;
  brew: boolean;
  npmWritable: boolean | null;
}

export interface InstallLine {
  /** the method's position in the harness's table: what a run names */
  index: number;
  via: InstallVia;
  label: string;
  command: string;
  note: string | null;
  /** why this machine can't run it ('Needs Node.js'), or null */
  blocked: string | null;
  /** the package manager whose runs wait for each other, or null */
  group: 'npm' | 'brew' | null;
  /** the one line offered first: the vendor's first this machine can run */
  recommended: boolean;
}

export declare const INSTALL_VIA_LABEL: Record<InstallVia, string>;
export declare const HARNESS_INSTALL: Record<string, HarnessInstallInfo>;
export declare function installOs(platform: string): InstallOs;
export declare function installArgv(command: string, platform: string): string[];
export declare function installGroup(via: string): 'npm' | 'brew' | null;
export declare function packageExecutionBlock(platform: string): string | null;
export declare function manualUpdateCommand(info: { command: string | null; latestStatus?: string | null }): string | null;
export declare function installMethod(kind: string, index: unknown, platform: string): InstallMethod | null;
export declare function installLines(kind: string, platform: string, tools: InstallTools | null): InstallLine[];
