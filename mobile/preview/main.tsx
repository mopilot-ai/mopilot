// Test-only injected runtime; it is never imported by the production entry.
import React from 'react';
import { createRoot } from 'react-dom/client';
import { MobileApp } from '../src/MobileApp';
const w = window as any;
w.cameraRequests = 0;
w.cameraGranted = false;
w.calls = [];
w.sendMode = 'reject';
w.followMode = 'normal';
w.answerMode = 'normal';
let state: any = {
  phase: 'online',
  generation: 1,
  user: { id: 'user', name: 'Alex' },
  pairs: [{ pairId: 'mac', macId: 'm', name: 'Studio Mac' }],
  selectedPair: 'mac',
  safetyNumber: null,
  pendingPair: false,
  pairCleanup: false,
  error: null,
  presence: { mac: { state: 'online', lastSeen: Date.now() } },
  reconnect: null,
  outbox: [],
};
const listeners = new Set<() => void>();
const events = new Set<(e: any) => void>();
w.changeState = (patch: object) => {
  state = { ...state, ...patch };
  listeners.forEach((f) => f());
};
w.emit = (event: any) => events.forEach((f) => f(event));
w.eventListeners = () => events.size;
let resolveSend: (value: any) => void;
w.acceptSend = () => resolveSend?.({ sent: true });
const runtime: any = {
  snapshot: () => state,
  subscribe: (f: any) => {
    listeners.add(f);
    return () => listeners.delete(f);
  },
  start: async () => {},
  signIn: async () => {},
  signOut: async () => w.changeState({ phase: 'signedOut', user: null }),
  pair: async () => {},
  cancelPairing: async () => w.changeState({ pendingPair: false }),
  connect: async () => {},
  disconnect: () => {},
  onEvent: (f: any) => {
    events.add(f);
    return () => events.delete(f);
  },
  request: async (method: string, params: any) => {
    w.calls.push({ method, params });
    if (method === 'chats.recent') return { chats: w.empty ? [] : [{ id: 'chat', title: 'Website launch', state: 'running' }] };
    if (method === 'chat.follow') {
      if (w.followMode === 'pending')
        await new Promise((resolve, reject) => {
          w.resolveFollow = resolve;
          w.rejectFollow = reject;
        });
      if (w.historyCase)
        return {
          rev: 1,
          feedSeq: 3,
          itemsShape: 'items',
          history: [
            ...Array.from({ length: 100 }, (_, i) => ({ role: 'user', text: `Old ${i}` })),
            { role: 'assistant', text: 'A streaming reply' },
          ],
          items: [{ id: 'live', type: 'agentMessage', text: 'A streaming reply continues' }],
          session: { cards: [] },
        };
      return {
        rev: 1,
        feedSeq: 0,
        historyStale: w.snapshotStale === true,
        itemsShape: 'rows',
        items: [
          { role: 'user', text: 'Review the launch plan' },
          { role: 'assistant', text: 'I am reviewing it now.' },
        ],
        session: {
          cards: [
            {
              id: 'a',
              rev: 1,
              title: 'Run this command?',
              detail: 'npm test',
              choices: [
                { key: 'once', label: 'Allow once' },
                { key: 'deny', label: 'Deny' },
              ],
            },
            {
              id: 'b',
              rev: 1,
              title: 'A question for you',
              questions: [{ id: 'q', question: 'Which option?', options: [{ label: 'One' }, { label: 'Two' }] }],
              choices: [{ key: 'submit', label: 'Send answer' }],
            },
          ],
        },
      };
    }
    if (method === 'card.answer' && w.answerMode === 'pending')
      return new Promise((resolve, reject) => {
        w.resolveAnswer = resolve;
        w.rejectAnswer = reject;
      });
    if (method === 'chat.send') {
      if (w.sendMode === 'reject') throw new Error('Computer refused the message');
      return new Promise((resolve) => {
        resolveSend = resolve;
      });
    }
    return {};
  },
};
createRoot(document.getElementById('root')!).render(<MobileApp runtime={runtime} />);
