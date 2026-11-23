// MoPilot 12-Grid Bench (#1381) webmail fixture (mail.localhost): folders, search, paging, reading, attachments,
// compose with uploads, reply and forward, move and label; every sent message and change is in its state for graders.
import { bytes, field, flashOf, html, logEvent, notFound, ok, page, paginate, parseBody, redirect, route, withFlash } from './kit.mjs';
import { freshId } from './records.mjs';

export const FOLDERS = ['inbox', 'archive', 'sent', 'trash'];
const EMAIL = /^[^\s@<>,;]+@[^\s@<>,;]+\.[^\s@<>,;]+$/;

/** "Name <a@b.c>" or "a@b.c" → { name, email }; null when there is no address. @param {unknown} s */
export function parseAddress(s) {
  const text = String(s ?? '').trim();
  const m = /^(.*?)\s*<([^>]+)>$/.exec(text);
  const email = (m ? m[2] : text).trim().toLowerCase();
  if (!EMAIL.test(email)) return null;
  const name = (m ? m[1] : '').replace(/^"|"$/g, '').trim();
  return { name: name || email, email };
}

/** Recipients from a To or Cc field (comma or semicolon separated); `bad` lists what is not an address. @param {string} s */
export function parseRecipients(s) {
  const parts = s
    .split(/[,;]/)
    .map((x) => x.trim())
    .filter(Boolean);
  const good = [];
  const bad = [];
  for (const p of parts) {
    const a = parseAddress(p);
    if (a) good.push(a.email);
    else bad.push(p);
  }
  return { good, bad };
}

/** An attachment from a fixture: text or base64 content. @param {any} a */
const attachment = (a) => ({
  name: String(a.name),
  type: String(a.type ?? 'application/octet-stream'),
  data: a.base64 ?? Buffer.from(String(a.text ?? ''), 'utf8').toString('base64'),
});

/**
 * The mailbox from a task's fixture: `{ user: { name, email }, messages: [{ from, to, subject, body, date, folder?,
 * read?, labels?, attachments?: [{ name, type?, text? | base64? }] }] }`.
 * @param {any} f
 */
export function init(f) {
  const user = parseAddress(`${f?.user?.name ?? ''} <${f?.user?.email ?? ''}>`);
  if (!user) throw new Error('mail fixture needs user.email');
  if (!Array.isArray(f.messages)) throw new Error('mail fixture needs a messages list');
  const state = { user, messages: /** @type {any[]} */ ([]), seq: 0, events: /** @type {any[]} */ ([]) };
  const given = f.messages.map((/** @type {any} */ m) => m.id).filter(Boolean);
  if (new Set(given).size !== given.length) throw new Error('two messages share an id');
  const taken = new Set(given);
  for (const m of f.messages) {
    const from = typeof m.from === 'string' ? parseAddress(m.from) : parseAddress(`${m.from?.name ?? ''} <${m.from?.email ?? ''}>`);
    if (!from) throw new Error(`message "${m.subject}" has no sender address`);
    const folder = m.folder ?? 'inbox';
    if (!FOLDERS.includes(folder)) throw new Error(`unknown folder ${folder}`);
    state.messages.push({
      // a generated id never takes one the fixture gave
      id: m.id ?? freshId(state, 'MSG', (i) => taken.has(i)),
      folder,
      from,
      to: [m.to ?? user.email].flat(),
      cc: [m.cc ?? []].flat(),
      subject: String(m.subject ?? ''),
      body: String(m.body ?? ''),
      date: String(m.date ?? '2026-01-01T09:00:00Z'),
      read: !!m.read,
      labels: [...(m.labels ?? [])],
      attachments: (m.attachments ?? []).map(attachment),
    });
  }
  return state;
}

const TITLE = 'Mail';
const nav = (/** @type {any} */ s) => {
  const unread = s.messages.filter((m) => m.folder === 'inbox' && !m.read).length;
  return /** @type {[string, string][]} */ ([
    ['/f/inbox', `Inbox${unread ? ` (${unread})` : ''}`],
    ['/f/archive', 'Archive'],
    ['/f/sent', 'Sent'],
    ['/f/trash', 'Trash'],
    ['/compose', 'Compose'],
  ]);
};
const day = (/** @type {string} */ iso) => iso.slice(0, 16).replace('T', ' ');
const view = (/** @type {any} */ s, /** @type {URL} */ url, /** @type {string} */ title, /** @type {unknown} */ body, error = '') =>
  ok(page({ app: TITLE, title, nav: nav(s), flash: flashOf(url), error, body }));
const find = (/** @type {any} */ s, /** @type {string} */ id) => s.messages.find((/** @type {any} */ m) => m.id === id);

/** @type {[string, string, (req: any, s: any, p: Record<string, string>, now: number) => any][]} */
const ROUTES = [
  ['GET', '/', () => redirect('/f/inbox')],
  [
    'GET',
    '/f/:folder',
    (req, s, p) => {
      if (!FOLDERS.includes(p.folder)) return notFound('No such folder');
      const q = (req.url.searchParams.get('q') ?? '').trim().toLowerCase();
      const all = s.messages
        .filter((/** @type {any} */ m) => m.folder === p.folder)
        .filter(
          (/** @type {any} */ m) =>
            !q || [m.from.name, m.from.email, ...m.to, m.subject, m.body].some((x) => String(x).toLowerCase().includes(q)),
        )
        .sort((/** @type {any} */ a, /** @type {any} */ b) => b.date.localeCompare(a.date));
      const { items, pager } = paginate(all, req.url);
      const sent = p.folder === 'sent';
      const rows = items.map(
        (/** @type {any} */ m) =>
          html`<tr class="${m.read ? '' : 'unread'}"><td>${sent ? m.to.join(', ') : m.from.name}</td><td><a href="/m/${m.id}">${m.subject || '(no subject)'}</a>${m.attachments.length ? ' 📎' : ''}${m.labels.map((/** @type {string} */ l) => html` <span class="muted">[${l}]</span>`)}</td><td>${day(m.date)}</td></tr>`,
      );
      const name = p.folder[0].toUpperCase() + p.folder.slice(1);
      return view(
        s,
        req.url,
        name,
        html`<h1>${name}</h1><form method="get"><input type="search" name="q" value="${q}" aria-label="Search mail" placeholder="Search mail"> <button>Search</button></form>
<p class="muted">${all.length} conversation${all.length === 1 ? '' : 's'}</p>
<table><thead><tr><th>${sent ? 'To' : 'From'}</th><th>Subject</th><th>Date</th></tr></thead><tbody>${rows.length ? rows : html`<tr><td colspan="3">Nothing here.</td></tr>`}</tbody></table>${pager}`,
      );
    },
  ],
  [
    'GET',
    '/m/:id',
    (req, s, p, now) => {
      const m = find(s, p.id);
      if (!m) return notFound('No such message');
      m.read = true;
      logEvent(s, 'opened', { id: m.id }, now);
      return view(
        s,
        req.url,
        m.subject,
        html`<div class="card"><h1>${m.subject || '(no subject)'}</h1>
<p><strong>From:</strong> ${m.from.name} &lt;${m.from.email}&gt;<br><strong>To:</strong> ${m.to.join(', ')}${m.cc.length ? html`<br><strong>Cc:</strong> ${m.cc.join(', ')}` : ''}<br><strong>Date:</strong> ${day(m.date)}</p>
<pre class="body">${m.body}</pre>
${m.attachments.length ? html`<p><strong>Attachments:</strong> ${m.attachments.map((/** @type {any} */ a, /** @type {number} */ i) => html`<a href="/m/${m.id}/att/${i}">${a.name}</a> `)}</p>` : ''}</div>
<p><a href="/compose?reply=${m.id}">Reply</a> · <a href="/compose?forward=${m.id}">Forward</a></p>
<form class="inline" method="post" action="/m/${m.id}/move"><label for="folder">Move to</label><select id="folder" name="folder">${FOLDERS.filter((f) => f !== m.folder).map((f) => html`<option>${f}</option>`)}</select> <button>Move</button></form>
<form class="inline" method="post" action="/m/${m.id}/label"><label for="label">Add label</label><input id="label" name="label"> <button>Add label</button></form>`,
      );
    },
  ],
  [
    'GET',
    '/m/:id/att/:i',
    (_req, s, p, now) => {
      const a = find(s, p.id)?.attachments[Number(p.i)];
      if (!a) return notFound('No such attachment');
      logEvent(s, 'downloaded', { id: p.id, name: a.name }, now);
      return bytes(a.name, a.type, a.data);
    },
  ],
  ['GET', '/compose', (req, s) => compose(s, req.url, prefill(s, req.url))],
  [
    'POST',
    '/compose',
    (req, s, _p, now) => {
      const { fields, files } = parseBody(req);
      const draft = {
        to: field(fields, 'to'),
        cc: field(fields, 'cc'),
        subject: field(fields, 'subject'),
        body: fields.body?.[0] ?? '',
        reply: field(fields, 'reply'),
        forward: field(fields, 'forward'),
      };
      const to = parseRecipients(draft.to);
      const cc = parseRecipients(draft.cc);
      const bad = [...to.bad, ...cc.bad];
      const error = !to.good.length ? 'Add at least one recipient.' : bad.length ? `Not an email address: ${bad.join(', ')}` : '';
      // the draft stays on the page with the error: nothing typed is lost
      if (error) return { ...compose(s, req.url, draft, error), status: 422 };
      const original = draft.forward ? find(s, draft.forward) : null;
      const id = freshId(s, 'MSG', (i) => !!find(s, i));
      s.messages.push({
        id,
        folder: 'sent',
        from: s.user,
        to: to.good,
        cc: cc.good,
        subject: draft.subject,
        body: draft.body,
        date: new Date(now).toISOString(),
        read: true,
        labels: [],
        attachments: [
          ...(original?.attachments ?? []),
          ...files.filter((f) => f.field === 'attach').map(({ name, type, data }) => ({ name, type, data })),
        ],
        ...(draft.reply ? { inReplyTo: draft.reply } : {}),
        ...(original ? { forwardOf: original.id } : {}),
      });
      logEvent(s, 'sent', { id, to: to.good, subject: draft.subject }, now);
      return redirect(withFlash('/f/sent', 'Message sent.'));
    },
  ],
  [
    'POST',
    '/m/:id/move',
    (req, s, p, now) => {
      const m = find(s, p.id);
      const folder = field(parseBody(req).fields, 'folder');
      if (!m || !FOLDERS.includes(folder)) return notFound('No such message or folder');
      const from = m.folder;
      m.folder = folder;
      logEvent(s, 'moved', { id: m.id, from, to: folder }, now);
      return redirect(withFlash(`/f/${from}`, `Moved to ${folder}.`));
    },
  ],
  [
    'POST',
    '/m/:id/label',
    (req, s, p, now) => {
      const m = find(s, p.id);
      if (!m) return notFound('No such message');
      const label = field(parseBody(req).fields, 'label');
      if (label && !m.labels.includes(label)) {
        m.labels.push(label);
        logEvent(s, 'labeled', { id: m.id, label }, now);
      }
      return redirect(withFlash(`/m/${m.id}`, label ? `Labeled ${label}.` : 'Type a label first.'));
    },
  ],
];

/** What the compose form starts with: a reply quotes the message, a forward carries its attachments. @param {any} s @param {URL} url */
function prefill(s, url) {
  const reply = find(s, url.searchParams.get('reply') ?? '');
  const forward = find(s, url.searchParams.get('forward') ?? '');
  const quote = (/** @type {any} */ m) => `\n\nOn ${day(m.date)}, ${m.from.name} wrote:\n${m.body.replace(/^/gm, '> ')}`;
  if (reply)
    return {
      to: reply.from.email,
      cc: '',
      subject: /^re:/i.test(reply.subject) ? reply.subject : `Re: ${reply.subject}`,
      body: quote(reply),
      reply: reply.id,
      forward: '',
    };
  if (forward) return { to: '', cc: '', subject: `Fwd: ${forward.subject}`, body: quote(forward), reply: '', forward: forward.id };
  return { to: url.searchParams.get('to') ?? '', cc: '', subject: '', body: '', reply: '', forward: '' };
}

/** @param {any} s @param {URL} url @param {{ to: string, cc: string, subject: string, body: string, reply: string, forward: string }} d */
function compose(s, url, d, error = '') {
  const carried = d.forward ? (find(s, d.forward)?.attachments ?? []) : [];
  return view(
    s,
    url,
    'Compose',
    html`<h1>New message</h1><form method="post" action="/compose" enctype="multipart/form-data">
<input type="hidden" name="reply" value="${d.reply}"><input type="hidden" name="forward" value="${d.forward}">
<label for="to">To</label><input id="to" name="to" size="60" value="${d.to}">
<label for="cc">Cc</label><input id="cc" name="cc" size="60" value="${d.cc}">
<label for="subject">Subject</label><input id="subject" name="subject" size="60" value="${d.subject}">
<label for="body">Message</label><textarea id="body" name="body">${d.body}</textarea>
${carried.length ? html`<p class="muted">Forwarding: ${carried.map((/** @type {any} */ a) => a.name).join(', ')}</p>` : ''}
<label for="attach">Attach files</label><input id="attach" type="file" name="attach" multiple>
<p><button>Send</button></p></form>`,
    error,
  );
}

/** @type {import('./server.mjs').App} */
export const mail = {
  name: 'mail',
  title: TITLE,
  init,
  handle(req, state, { now }) {
    const hit = route(req.method, req.url.pathname, ROUTES);
    return hit ? hit.handler(req, state, hit.params, now) : notFound();
  },
};
