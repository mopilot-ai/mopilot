import type { VersionStore } from '../momoNotice/types.d.ts';
import type { AccountFile, ClientConfig } from './types.mjs';
/** The Host's safeStorage shape (Electron's, and the Host's key-file one). */
export type SafeStorage = {
  isEncryptionAvailable(): boolean;
  encryptString(text: string): Buffer;
  decryptString(data: Buffer): string;
};
export declare class SealUnavailableError extends Error {
  constructor();
}
/** The file operations the Host supplies (its `node:fs/promises`): shared code reaches no file system of its own. */
export type FileIo = {
  readFile(file: string, encoding: 'utf8'): Promise<string>;
  writeFile(
    file: string,
    data: string,
    options: {
      mode: number;
    },
  ): Promise<void>;
  mkdir(
    dir: string,
    options: {
      recursive: true;
      mode: number;
    },
  ): Promise<unknown>;
  chmod(file: string, mode: number): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  rm(
    file: string,
    options: {
      force: true;
    },
  ): Promise<void>;
};
/** The account record file: `<dir>/google-account.sealed`. */
export declare function createAccountFile(dir: string, safeStorage: SafeStorage, io: FileIo): AccountFile;
/** The durable cursors, read by the notice pipeline's change detection: `<dir>/google-versions.sealed`. */
export declare const MAX_CURSORS = 5000;
export declare function createVersionStore(
  dir: string,
  safeStorage: SafeStorage,
  io: FileIo,
  options?: { delayMs?: number; max?: number; report?: (error: unknown) => void },
): VersionStore & {
  /** Writes the cursors now (they are otherwise written within half a second of a change). */
  flush(): Promise<void>;
  /** Forgets what is in memory without writing it. */
  discard(): void;
  clear(): Promise<void>;
};
export type Clients = { desktop: ClientConfig; ios?: ClientConfig };
/** The Google OAuth clients this home holds, sealed like the rest so a move carries them. */
export declare function createClientsFile(
  dir: string,
  safeStorage: SafeStorage,
  io: FileIo,
): { load(): Promise<Clients | null>; save(c: Clients): Promise<void>; clear(): Promise<void> };

export type OwedRevoke = { token: string; at: number };
export declare const MAX_OWED: number;
export declare function createOwedFile(
  dir: string,
  safeStorage: SafeStorage,
  io: FileIo,
): { load(): Promise<OwedRevoke[]>; save(owed: OwedRevoke[]): Promise<void> };
