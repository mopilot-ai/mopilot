// A generic online store for the "chat with support about a delayed order" errand journey: a sign-in page whose form lives in a
// cross-origin iframe with a two-step code, an order list with one delayed order, and a support chat that opens in a new window and
// runs in a cross-origin iframe (a queue, an advisor who types with delays and answers vaguely first, an offer that needs the customer's
// consent, an idle warning and a dropped connection). Two servers: the store on 127.0.0.1 and the sign-in and chat widgets on localhost,
// so the frames are another site (out of process). With chatMode 'tab' the chat is instead a page of its own on that other site, opened
// in a new tab (as stores that send order help to a separate support site do). The test plays the user with /__user/* routes; nothing
// here names a real company.
import http from 'node:http';

const ORDER = { id: 'W100200300', item: 'Laptop 14-inch', promised: 'October 28', now: 'November 14', shipping: 'Standard shipping' };
const CASE = 'C-55120873';

const page = (title, body, script = '') =>
  `<!doctype html><html lang="en"><meta charset="utf-8"><title>${title}</title><body>${body}${script ? `<script>${script}</script>` : ''}</body></html>`;
const send = (res, code, type, body, headers = {}) =>
  res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store', ...headers }).end(body);
const html = (res, title, body, script) => send(res, 200, 'text/html; charset=utf-8', page(title, body, script));
const json = (res, value) => send(res, 200, 'application/json', JSON.stringify(value), { 'access-control-allow-origin': '*' });
const readBody = (req) =>
  new Promise((resolve) => {
    let s = '';
    req.on('data', (c) => (s += c));
    req.on('end', () => resolve(s));
  });
// no host for the widgets: localhost may resolve to ::1 or 127.0.0.1, so they listen on both
const listen = (server, host) => new Promise((resolve) => server.listen(0, host, () => resolve(server.address().port)));

/**
 * The advisor's side of one chat: a script of replies keyed to how far the conversation got. Times are in milliseconds.
 * @param {{ queueMs: number, typingMs: number, idleMs: number, dropAfterFirst: boolean }} o
 */
function newChat(o) {
  return {
    o,
    started: Date.now(),
    /** @type {{ who: 'advisor' | 'you' | 'system', text: string, at: number }[]} */
    lines: [],
    stage: 'queue',
    /** when the advisor's next line shows, and what it is */
    pending: /** @type {null | { at: number, text: string, then?: string }} */ (null),
    lastYou: 0,
    warned: false,
    dropped: false,
    droppedOnce: false,
    offer: '',
  };
}

/** Moves a chat forward to `now`: the queue ends, a typed reply lands, an idle chat is warned and then closed. */
function tick(chat, now = Date.now()) {
  const { o } = chat;
  if (chat.stage === 'queue' && now - chat.started >= o.queueMs) {
    chat.stage = 'open';
    chat.lines.push({ who: 'advisor', text: `Hi, I'm Sam from Store Support. How can I help you today?`, at: now });
    chat.lastYou = now;
  }
  if (chat.pending && now >= chat.pending.at) {
    chat.lines.push({ who: 'advisor', text: chat.pending.text, at: chat.pending.at });
    if (chat.pending.then) chat.stage = chat.pending.then;
    chat.pending = null;
    chat.lastYou = now;
    if (o.dropAfterFirst && !chat.droppedOnce) {
      chat.dropped = true;
      chat.droppedOnce = true;
    }
  }
  if (chat.stage !== 'queue' && chat.stage !== 'ended' && !chat.pending && !chat.dropped) {
    if (!chat.warned && now - chat.lastYou >= o.idleMs) {
      chat.warned = true;
      chat.lines.push({ who: 'system', text: 'Are you still there? This chat will close in 1 minute if there is no reply.', at: now });
    } else if (chat.warned && now - chat.lastYou >= o.idleMs * 2) {
      chat.stage = 'ended';
      chat.lines.push({ who: 'system', text: 'This chat ended because there was no reply.', at: now });
    }
  }
}

/** The advisor's answer to what the customer wrote, by stage: vague first, then the real date and an offer, then the outcome. */
function answer(chat, text) {
  const t = text.toLowerCase();
  if (chat.stage === 'offer') {
    if (/\b(yes|accept|apply|take)\b/.test(t) && /credit/.test(t))
      return {
        text: `Done. I've applied a $25 store credit to your account. Your case number is ${CASE}. Is there anything else?`,
        then: 'closing',
      };
    if (/\b(yes|accept|go ahead)\b/.test(t) && /(cancel|reorder)/.test(t))
      return {
        text: `I've cancelled order ${ORDER.id}. A new order with express shipping will follow by email. Case ${CASE}.`,
        then: 'closing',
      };
    if (/\b(no|decline)\b/.test(t)) return { text: `Understood, no changes made. Your case number is ${CASE}.`, then: 'closing' };
    return { text: 'Would you like the $25 credit, or should I cancel and reorder with express shipping?' };
  }
  if (chat.stage === 'open') {
    if (!t.includes(ORDER.id.toLowerCase())) return { text: 'Could you share your order number, please? It starts with W.' };
    return { text: 'Thanks. I can see your order is on its way and should arrive soon.', then: 'vague' };
  }
  if (chat.stage === 'vague') {
    chat.offer = '$25 credit or cancel and reorder';
    return {
      text: `I'm sorry for the wait. Order ${ORDER.id} is now expected to arrive on ${ORDER.now}, not ${ORDER.promised}. I can offer a $25 store credit, or I can cancel the order and reorder it with free express shipping.`,
      then: 'offer',
    };
  }
  return { text: `You're welcome. Your case number is ${CASE}. Have a good day!` };
}

const WIDGET_SCRIPT = (base) => `
const q = new URLSearchParams(location.search);
const id = q.get('chat');
const log = document.getElementById('log'), status = document.getElementById('status');
const box = document.getElementById('msg'), btn = document.getElementById('send');
let seen = -1;
async function poll() {
  try {
    const r = await (await fetch('${base}/chat/state?chat=' + id)).json();
    status.textContent = r.status;
    document.getElementById('reconnect').hidden = !r.dropped;
    box.disabled = btn.disabled = r.stage === 'queue' || r.stage === 'ended' || r.dropped;
    document.getElementById('typing').hidden = !r.typing;
    if (r.lines.length !== seen) {
      seen = r.lines.length;
      log.innerHTML = '';
      for (const l of r.lines) {
        const li = document.createElement('li');
        li.className = l.who;
        li.textContent = (l.who === 'you' ? 'You: ' : l.who === 'advisor' ? 'Sam: ' : '') + l.text;
        log.appendChild(li);
      }
    }
  } catch { status.textContent = 'Connecting...'; }
}
setInterval(poll, 500); poll();
document.getElementById('form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const text = box.value.trim();
  if (!text) return;
  box.value = '';
  await fetch('${base}/chat/say?chat=' + id, { method: 'POST', body: text });
  poll();
});
document.getElementById('reconnect').addEventListener('click', async () => {
  await fetch('${base}/chat/reconnect?chat=' + id, { method: 'POST' });
  poll();
});
`;

/**
 * Starts the store and its widgets. Options set the timings (ms); the defaults are short for a test.
 * @param {{ queueMs?: number, typingMs?: number, idleMs?: number, dropAfterFirst?: boolean, chatMode?: 'popup' | 'tab' }} [opts]
 */
export async function startErrandStore(opts = {}) {
  const o = { queueMs: 4000, typingMs: 1500, idleMs: 60_000, dropAfterFirst: false, chatMode: 'popup', ...opts };
  /** sign-in attempts the user finished (by the sign-in widget, or the test playing the user) */
  const signins = new Map();
  /** @type {Map<string, ReturnType<typeof newChat>>} */
  const chats = new Map();
  const sessions = new Set();
  let n = 0;
  const urls = { store: '', widgets: '' };

  const widgets = http.createServer(async (req, res) => {
    const u = new URL(req.url ?? '/', 'http://x');
    if (u.pathname === '/idp') {
      const attempt = u.searchParams.get('attempt') ?? '';
      return html(
        res,
        'Sign in',
        `<form id="f"><h2>Sign in to Store</h2><label>Email <input name="email" type="email" autocomplete="username"></label>
<label>Password <input name="password" type="password" autocomplete="current-password"></label><button>Continue</button></form>
<form id="code" hidden><h2>Two-step verification</h2><p>Enter the code sent to your phone.</p>
<label>Code <input name="code" autocomplete="one-time-code" inputmode="numeric"></label><button>Verify</button></form>`,
        `document.getElementById('f').onsubmit = (e) => { e.preventDefault(); e.target.hidden = true; document.getElementById('code').hidden = false; };
document.getElementById('code').onsubmit = async (e) => { e.preventDefault(); await fetch('/idp/done?attempt=${attempt}', { method: 'POST' }); };`,
      );
    }
    if (u.pathname === '/idp/done') {
      signins.set(u.searchParams.get('attempt'), true);
      return json(res, { ok: true });
    }
    // the chat as its own page on the support site (chatMode 'tab'): a new chat, then the same widget at the top
    if (u.pathname === '/support-site') {
      const id = `chat${chats.size + 1}`;
      chats.set(id, newChat(o));
      return send(res, 302, 'text/plain', '', { location: `/widget?chat=${id}` });
    }
    if (u.pathname === '/widget') {
      return html(
        res,
        'Store Support chat',
        `<h2>Store Support</h2><p id="status" role="status">Connecting...</p><ol id="log" aria-label="Chat messages"></ol>
<p id="typing" hidden>Sam is typing...</p><button id="reconnect" hidden>Reconnect</button>
<form id="form"><label>Message <textarea id="msg" name="msg" rows="2"></textarea></label><button id="send">Send</button></form>`,
        WIDGET_SCRIPT(urls.widgets),
      );
    }
    const chat = chats.get(u.searchParams.get('chat') ?? '');
    if (u.pathname.startsWith('/chat/') && !chat)
      return send(res, 404, 'text/plain', 'no such chat', { 'access-control-allow-origin': '*' });
    if (u.pathname === '/chat/state') {
      tick(chat);
      const ahead = Math.max(1, Math.ceil((o.queueMs - (Date.now() - chat.started)) / 1500));
      const statusText = chat.dropped
        ? 'Connection lost.'
        : chat.stage === 'queue'
          ? `You're number ${ahead} in line. An advisor will be with you shortly.`
          : chat.stage === 'ended'
            ? 'Chat ended.'
            : 'Connected to Sam';
      return json(res, { stage: chat.stage, status: statusText, dropped: chat.dropped, typing: !!chat.pending, lines: chat.lines });
    }
    if (u.pathname === '/chat/say' && req.method === 'POST') {
      const text = (await readBody(req)).slice(0, 2000);
      tick(chat);
      if (chat.stage === 'queue' || chat.stage === 'ended' || chat.dropped) return json(res, { ok: false });
      chat.lines.push({ who: 'you', text, at: Date.now() });
      chat.lastYou = Date.now();
      chat.warned = false;
      const a = answer(chat, text);
      chat.pending = { at: Date.now() + o.typingMs, ...a };
      return json(res, { ok: true });
    }
    if (u.pathname === '/chat/reconnect' && req.method === 'POST') {
      chat.dropped = false;
      chat.lastYou = Date.now();
      chat.lines.push({ who: 'system', text: 'Reconnected. Your conversation is still here.', at: Date.now() });
      return json(res, { ok: true });
    }
    send(res, 404, 'text/plain', 'not found');
  });

  const store = http.createServer(async (req, res) => {
    const u = new URL(req.url ?? '/', 'http://x');
    const sid = /(?:^|;\s*)sid=([^;]+)/.exec(req.headers.cookie ?? '')?.[1] ?? '';
    const signedIn = sessions.has(sid);
    // the test playing the user: finish every pending sign-in (the user typed their password and code)
    if (u.pathname === '/__user/signin') {
      for (const k of signins.keys()) signins.set(k, true);
      return json(res, { attempts: signins.size });
    }
    if (u.pathname === '/__user/sessions') return json(res, { sessions: sessions.size });
    if (u.pathname === '/__user/chats')
      return json(
        res,
        [...chats.entries()].map(([id, c]) => ({ id, stage: c.stage, lines: c.lines })),
      );
    if (u.pathname === '/')
      return html(res, 'Store', `<h1>Store</h1><nav><a href="/orders">Order status</a> <a href="/help">Help</a></nav>`);
    if (u.pathname === '/signin') {
      const attempt = String(++n);
      signins.set(attempt, false);
      const next = u.searchParams.get('next') ?? '/orders';
      return html(
        res,
        'Sign in - Store',
        `<h1>Sign in to see your orders</h1><iframe title="Sign in" src="${urls.widgets}/idp?attempt=${attempt}" width="420" height="320"></iframe>`,
        `setInterval(async () => { const r = await (await fetch('/signin/status?attempt=${attempt}')).json(); if (r.done) location.href = '/signin/complete?attempt=${attempt}&next=' + encodeURIComponent(${JSON.stringify(next)}); }, 500);`,
      );
    }
    if (u.pathname === '/signin/status') return json(res, { done: signins.get(u.searchParams.get('attempt')) === true });
    if (u.pathname === '/signin/complete') {
      if (signins.get(u.searchParams.get('attempt')) !== true) return send(res, 302, 'text/plain', '', { location: '/signin' });
      const s = `s${Date.now()}${Math.random().toString(36).slice(2)}`;
      sessions.add(s);
      const next = u.searchParams.get('next') ?? '/orders';
      return send(res, 302, 'text/plain', '', {
        location: next.startsWith('/') ? next : '/orders',
        'set-cookie': `sid=${s}; Path=/; HttpOnly`,
      });
    }
    if (!signedIn && (u.pathname.startsWith('/orders') || u.pathname === '/support'))
      return send(res, 302, 'text/plain', '', { location: `/signin?next=${encodeURIComponent(u.pathname + u.search)}` });
    if (u.pathname === '/orders')
      return html(
        res,
        'Your orders - Store',
        `<h1>Your orders</h1><table><tr><th>Order</th><th>Item</th><th>Status</th></tr>
<tr><td><a href="/orders/${ORDER.id}">${ORDER.id}</a></td><td>${ORDER.item}</td><td>Delayed</td></tr>
<tr><td>W100200111</td><td>Phone case</td><td>Delivered September 3</td></tr></table>`,
      );
    if (u.pathname === `/orders/${ORDER.id}`)
      return html(
        res,
        `Order ${ORDER.id} - Store`,
        `<h1>Order ${ORDER.id}</h1><p>${ORDER.item}. ${ORDER.shipping}.</p><p>Delivery was promised by ${ORDER.promised}.</p>
<p><strong>Delayed.</strong> New estimate: ${ORDER.now}.</p>${
          o.chatMode === 'tab'
            ? `<a href="${urls.widgets}/support-site?order=${ORDER.id}" target="_blank">Chat with us</a>`
            : '<button id="chat">Chat with us</button>'
        }`,
        o.chatMode === 'tab'
          ? ''
          : `document.getElementById('chat').onclick = () => window.open('/support?order=${ORDER.id}', 'support', 'width=440,height=680');`,
      );
    if (u.pathname === '/support') {
      const id = `chat${chats.size + 1}`;
      chats.set(id, newChat(o));
      return html(
        res,
        'Chat with Store Support',
        `<h1>Chat with Store Support</h1><p>About order ${u.searchParams.get('order') ?? ''}</p>
<iframe title="Support chat" src="${urls.widgets}/widget?chat=${id}" width="420" height="560"></iframe>`,
      );
    }
    send(res, 404, 'text/plain', 'not found');
  });

  const sp = await listen(store, '127.0.0.1');
  const wp = await listen(widgets, undefined);
  urls.store = `http://127.0.0.1:${sp}`;
  // localhost and 127.0.0.1 are different sites, so the frames run in their own process as on the real web
  urls.widgets = `http://localhost:${wp}`;
  return {
    ...urls,
    order: ORDER,
    caseNumber: CASE,
    chats,
    async close() {
      for (const s of [store, widgets]) {
        s.closeAllConnections();
        await new Promise((r) => s.close(r));
      }
    },
  };
}

export const _test = { newChat, tick, answer, ORDER, CASE };
