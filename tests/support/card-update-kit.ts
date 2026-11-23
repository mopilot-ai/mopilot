// Shared card protocol fixtures: real remote service and memory phones, controlled history promises and versioned cards.
import assert from 'node:assert/strict';
import { rig } from './remote-kit.ts';

export const deferred = () => {
  let resolve!: (value: any) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<any>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
};
export const card = (id: string) => ({ id, title: id, version: id });

export async function followed() {
  const r = rig();
  const p = r.phone('p1');
  assert.equal((await p.ask('chat.follow', { chatId: 'c1' })).ok, true);
  return { r, p };
}
