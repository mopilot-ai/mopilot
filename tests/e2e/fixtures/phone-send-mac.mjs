// A runner-local fake Mac holds start/send replies until XCTest explicitly releases them; no accounts or relay are involved.
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { messageIdentity } from '../../../shared/remote/messageIdentity.mjs';

/** A 1x1 JPEG: the shrunk picture messages.image answers with (a record's picture is normally drawn from the phone's own preview). */
export const TINY_JPEG =
  '/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=';
const hash = (bytes) => createHash('sha256').update(bytes).digest();
const nothing = () => ({ text: '', attachments: [], method: '', id: '', chatId: null });

export async function startPhoneSendMac() {
  let start;
  let send;
  let first = nothing();
  let latest = nothing();
  let started = false;
  let count = 0;
  let startIds = [];
  let users = [];
  let events = [];
  let hosts = false;
  let legacy = false;
  let startAttachments = [];
  let sendAttachments = [];
  let startHosts = [];
  let uploads = [];
  let streams = {};
  let imageReads = 0;
  const json = (response, value) => response.end(JSON.stringify(value));
  const release = (pending, value) => {
    if (!pending) throw new Error('No pending request');
    json(pending, value);
  };
  // A phone message with pictures is recorded with the id and native correlation id the real Mac derives for its pair.
  const userRow = ({ text, attachments, method, id, chatId }) =>
    attachments.length
      ? {
          role: 'user',
          text,
          id: `message-${count + 1}`,
          images: attachments.length,
          clientId: messageIdentity(hash, 'pair', method, chatId, id),
        }
      : { role: 'user', text };
  const state = () => ({
    pendingStart: !!start,
    pendingSend: !!send,
    recordCount: count,
    startIds,
    startAttachments,
    sendAttachments,
    startHosts,
    uploads,
    imageReads,
  });
  const server = createServer(async (request, response) => {
    response.setHeader('Content-Type', 'application/json');
    try {
      const url = new URL(request.url ?? '/', 'http://localhost');
      if (url.pathname === '/events') return json(response, events.slice(Number(url.searchParams.get('after') ?? 0)));
      if (url.pathname.startsWith('/control/')) {
        switch (url.pathname.slice('/control/'.length)) {
          case 'reset':
            if (start) json(start, { error: 'Test reset' });
            if (send) json(send, { error: 'Test reset' });
            start = send = undefined;
            first = latest = nothing();
            hosts = legacy = false;
            startAttachments = [];
            sendAttachments = [];
            startHosts = [];
            uploads = [];
            streams = {};
            imageReads = 0;
            started = false;
            count = 0;
            startIds = [];
            users = [];
            events = [];
            break;
          case 'acceptStart':
            release(start, { chatId: 'claude:native-send', warning: 'Mac accepted start; transcript pending.' });
            start = undefined;
            started = true;
            break;
          case 'refuseStart':
            release(start, { error: 'Fake Mac refused this start.' });
            start = undefined;
            break;
          case 'ackSend':
            release(send, {});
            send = undefined;
            break;
          case 'record':
            users.push(userRow(count === 0 ? first : latest));
            count += 1;
            // A noncurrent transcript event asks the real follow service for a fresh authoritative snapshot.
            events.push({ ev: 'items.append', chatId: 'claude:native-send', feedSeq: events.length + 1, live: false, items: [] });
            break;
          case 'hosts':
            hosts = true;
            break;
          case 'legacy':
            legacy = true;
            break;
          case 'state':
            break;
          default:
            throw new Error('Unknown control');
        }
        return json(response, state());
      }
      if (url.pathname !== '/rpc') throw new Error('Unknown endpoint');
      let body = '';
      for await (const chunk of request) body += chunk;
      const { method, params = {} } = JSON.parse(body);
      switch (method) {
        case 'machine.hello':
          return json(response, {
            capabilities: {
              permissionCeiling: 'auto-review',
              methods: [],
              ...(legacy ? {} : { messageIdentity: 1 }),
              ...(hosts ? { machines: true } : {}),
            },
          });
        case 'machines.list':
          return json(response, {
            machines: [
              { id: 'local', name: 'This Mac', status: 'online', line: 'This Mac', tone: 'ok', agents: [] },
              {
                id: 'host-1',
                name: 'Fake Host',
                status: 'online',
                line: 'Online · direct',
                tone: 'ok',
                agents: [{ id: 'claude', label: 'Claude Code', state: 'ready', via: 'own' }],
              },
            ],
          });
        case 'machines.folders':
          return json(response, { path: params.path ?? null, roots: params.path ? [] : ['/srv/work'], entries: [], more: false });
        case 'chat.attach': {
          // one chunk or several: the file is done with the last, and only then does the Mac name it
          streams[params.stream] = (streams[params.stream] ?? 0) + Buffer.from(params.data, 'base64').length;
          const done = params.index + 1 >= params.total;
          const id = `attachment-${uploads.length + 1}`;
          if (done) uploads.push({ id, name: params.name, mime: params.mime, bytes: streams[params.stream] });
          return json(response, { stream: params.stream, received: params.index + 1, done, ...(done ? { id } : {}) });
        }
        case 'messages.image':
          imageReads += 1;
          return json(response, { data: TINY_JPEG, width: 1, height: 1 });
        case 'harnesses.list':
          return json(response, { harnesses: [{ id: 'claude', label: 'Claude Code' }] });
        case 'projects.list':
          return json(response, { projects: [] });
        case 'options.get':
          return json(response, {
            models: [{ id: 'native-model', label: 'Native model', efforts: [] }],
            model: 'native-model',
            permission: { value: 'default', rows: [{ id: 'default', label: 'Ask' }] },
          });
        case 'chats.recent':
          return json(response, {
            chats: started ? [{ id: 'claude:native-send', title: 'Native send chat', state: 'idle', harness: 'claude' }] : [],
          });
        case 'chat.start':
          if (start) throw new Error('Overlapping starts');
          first = { text: params.text, attachments: params.attachments ?? [], method: 'chat.start', id: params.startId, chatId: null };
          startIds.push(params.startId);
          startAttachments.push(first.attachments);
          startHosts.push({ hostId: params.hostId ?? null, folder: params.folder ?? null });
          start = response;
          return;
        case 'chat.send':
          if (send) throw new Error('Overlapping sends');
          latest = {
            text: params.text,
            attachments: params.attachments ?? [],
            method: 'chat.send',
            id: params.sendId,
            chatId: params.chatId,
          };
          sendAttachments.push(latest.attachments);
          send = response;
          return;
        case 'chat.follow':
          return json(response, {
            rev: 1,
            feedSeq: events.length,
            session: { turn: 'idle', cards: [] },
            itemsShape: 'rows',
            items: [...users, { role: 'step', text: count ? `Record ${count} applied` : 'Running without user record' }],
          });
        default:
          return json(response, {});
      }
    } catch (error) {
      json(response, { error: error.message });
    }
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(undefined));
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Fake Mac has no TCP address');
  return {
    origin: `http://localhost:${address.port}`,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(resolve);
      }),
  };
}
