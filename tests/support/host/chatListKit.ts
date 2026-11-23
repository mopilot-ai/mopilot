// Shared pieces of the Host chat list tests (#4884): a temporary Host folder, where a chat's folder is, one durable frame, a set last write time, and the real file system with some calls answered differently.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

export const BASE = Date.now() + 60_000;
export const tmp = (t: any) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-list-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
};
export const dirOf = (data: string, chatId: string) =>
  path.join(data, 'sessions', crypto.createHash('sha256').update(chatId).digest('hex'));
/** One durable frame, so the chat is written to disk. */
export const write = (j: any, chatId: string) =>
  j.durable(chatId, { seq: j.next(chatId), rev: j.head(chatId).rev + 1, item: { type: 'x' } });
/** Sets a file's last write to `ahead` ms after now, past every chat's creation. */
export const touch = (file: string, ahead: number) => fs.utimesSync(file, (BASE + ahead) / 1000, (BASE + ahead) / 1000);

/** The real file system with some calls answered differently: `over` maps a method to a function of its real answer and arguments. */
export const fsWith = (over: Record<string, (real: any, ...args: any[]) => unknown>): any =>
  new Proxy(fs, {
    get: (target, key: string) =>
      over[key] ? (...a: unknown[]) => over[key]((target as any)[key].bind(target), ...a) : (target as any)[key],
  });
