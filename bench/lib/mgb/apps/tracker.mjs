// MoPilot 12-Grid Bench (#1381) issue tracker fixture (tracker.localhost): filtered and paged issue lists, issue pages
// with attachments and comments, new issues with uploads, edits and status changes; all in its state and event log.
import { bytes, field, flashOf, html, logEvent, notFound, ok, page, paginate, parseBody, redirect, route, withFlash } from './kit.mjs';
import {
  applyChanges,
  assignIds,
  checkboxes,
  count,
  freshId,
  input,
  matches,
  param,
  records,
  rowsOr,
  searchForm,
  select,
  textarea,
} from './records.mjs';

export const STATUSES = ['todo', 'in progress', 'in review', 'done'];
export const PRIORITIES = ['low', 'medium', 'high', 'urgent'];

/** An attachment from a fixture: text or base64 content. @param {any} a */
const attachment = (a) => ({
  name: String(a.name),
  type: String(a.type ?? 'application/octet-stream'),
  data: a.base64 ?? Buffer.from(String(a.text ?? ''), 'utf8').toString('base64'),
});

/** A list of names from a fixture. @param {any} f @param {string} key */
function names(f, key) {
  const list = f[key];
  if (!Array.isArray(list) || !list.every((x) => typeof x === 'string' && x.trim()))
    throw new Error(`tracker fixture needs ${key} as a list of names`);
  return list.map((x) => x.trim());
}

/**
 * The tracker from a task's fixture: `{ user: { name }, project: { key, name }, members: string[], labels: string[],
 * issues: [{ key?, title, body?, status?, priority?, assignee?, labels?, comments?: [{ author, body, at? }],
 * attachments?: [{ name, type?, text? | base64? }] }] }`.
 * @param {any} f
 */
export function init(f) {
  const user = String(f?.user?.name ?? '').trim();
  if (!user) throw new Error('tracker fixture needs user.name');
  const key = String(f.project?.key ?? '').trim();
  if (!/^[A-Z][A-Z0-9]*$/.test(key)) throw new Error('tracker fixture needs project.key in capitals, like WEB');
  const issues = records(f, 'issues', 'tracker');
  const state = {
    user: { name: user },
    project: { key, name: String(f.project.name ?? key) },
    members: names(f, 'members'),
    labels: names(f, 'labels'),
    issues: /** @type {any[]} */ ([]),
    seq: 0,
    events: /** @type {any[]} */ ([]),
  };
  const keys = assignIds(state, key, issues, 'key');
  issues.forEach((x, i) => {
    const d = {
      title: String(x.title ?? ''),
      body: String(x.body ?? ''),
      status: x.status ?? 'todo',
      priority: x.priority ?? 'medium',
      assignee: x.assignee ?? '',
      labels: [x.labels ?? []].flat(),
    };
    const error = issueError(state, d);
    if (error) throw new Error(`issue ${keys[i]}: ${error}`);
    const comments = (x.comments ?? []).map((/** @type {any} */ c) => ({
      author: String(c.author),
      body: String(c.body),
      at: String(c.at ?? '2026-01-01T09:00:00Z'),
    }));
    state.issues.push({ key: keys[i], ...d, comments, attachments: (x.attachments ?? []).map(attachment) });
  });
  return state;
}

/** @typedef {{ title: string, body: string, status: string, priority: string, assignee: string, labels: string[] }} Draft */

/** What is wrong with an issue, or ''. @param {any} s @param {Draft} d */
function issueError(s, d) {
  if (!d.title.trim()) return 'Title is required.';
  if (!STATUSES.includes(d.status)) return `Unknown status: ${d.status}`;
  if (!PRIORITIES.includes(d.priority)) return `Unknown priority: ${d.priority}`;
  if (d.assignee && !s.members.includes(d.assignee)) return `Unknown assignee: ${d.assignee}`;
  const bad = d.labels.filter((l) => !s.labels.includes(l));
  return bad.length ? `Unknown label: ${bad.join(', ')}` : '';
}

/** The issue a form describes; `status` stays as it is unless the form has one. @param {Record<string, string[]>} fields @param {string} status */
const draftOf = (fields, status) => ({
  title: field(fields, 'title'),
  body: fields.body?.[0] ?? '',
  status,
  priority: field(fields, 'priority'),
  assignee: field(fields, 'assignee'),
  labels: (fields.labels ?? []).map((l) => l.trim()).filter(Boolean),
});

const TITLE = 'Tracker';
/** @type {[string, string][]} */
const NAV = [
  ['/issues', 'Issues'],
  ['/issues/new', 'New issue'],
];
const view = (/** @type {URL} */ url, /** @type {string} */ title, /** @type {unknown} */ body, error = '') =>
  ok(page({ app: TITLE, title, nav: NAV, flash: flashOf(url), error, body }));
const invalid = (/** @type {import('./kit.mjs').Res} */ res) => ({ ...res, status: 422 });
const find = (/** @type {any} */ s, /** @type {string} */ key) => s.issues.find((/** @type {any} */ i) => i.key === key);
const RANK = (/** @type {string} */ p) => PRIORITIES.length - PRIORITIES.indexOf(p);

/** The fields an issue form shares (new and edit). @param {any} s @param {Draft} d */
const issueFields = (s, d) =>
  html`${input('Title', 'title', d.title)}${textarea('Description', 'body', d.body)}${select('Priority', 'priority', PRIORITIES, d.priority)}${select('Assignee', 'assignee', [['', 'Unassigned'], ...s.members], d.assignee)}${checkboxes('Labels', 'labels', s.labels, d.labels)}`;

/** @param {URL} url @param {any} s @param {Draft} d */
const newIssue = (url, s, d, error = '') =>
  view(
    url,
    'New issue',
    html`<h1>New issue in ${s.project.name}</h1><form method="post" action="/issues" enctype="multipart/form-data">${issueFields(s, d)}
<label for="attach">Attach files</label><input id="attach" type="file" name="attach" multiple><p><button>Create issue</button></p></form>`,
    error,
  );

/** @param {URL} url @param {any} s @param {any} i @param {{ comment?: string, status?: string, error?: string }} [o] */
const issuePage = (url, s, i, o = {}) =>
  view(
    url,
    `${i.key} ${i.title}`,
    html`<div class="card"><h1>${i.key}: ${i.title}</h1><p>Status: ${i.status} · Priority: ${i.priority} · Assignee: ${i.assignee || 'Unassigned'}${i.labels.length ? ` · Labels: ${i.labels.join(', ')}` : ''}</p>
<pre class="body">${i.body}</pre>
${i.attachments.length ? html`<p><strong>Attachments:</strong> ${i.attachments.map((/** @type {any} */ a, /** @type {number} */ n) => html`<a href="/issues/${i.key}/att/${n}">${a.name}</a> `)}</p>` : ''}</div>
<p><a href="/issues/${i.key}/edit">Edit issue</a></p>
<form method="post" action="/issues/${i.key}/status">${select('Status', 'status', STATUSES, o.status ?? i.status)} <button>Change status</button></form>
<h2>Comments</h2>${i.comments.length ? i.comments.map((/** @type {any} */ c) => html`<div class="card"><p class="muted">${c.author} · ${c.at.slice(0, 16).replace('T', ' ')}</p><pre class="body">${c.body}</pre></div>`) : html`<p class="muted">No comments yet.</p>`}
<form method="post" action="/issues/${i.key}/comments">${textarea('Add a comment', 'comment', o.comment ?? '')}<p><button>Comment</button></p></form>`,
    o.error,
  );

/** @param {URL} url @param {any} s @param {any} i @param {Draft} d */
const editIssue = (url, s, i, d, error = '') =>
  view(
    url,
    `Edit ${i.key}`,
    html`<h1>Edit ${i.key}</h1><form method="post" action="/issues/${i.key}">${issueFields(s, d)}<p><button>Save issue</button></p></form>`,
    error,
  );

/** @type {[string, string, (req: any, s: any, p: Record<string, string>, now: number) => any][]} */
const ROUTES = [
  ['GET', '/', () => redirect('/issues')],
  [
    'GET',
    '/issues',
    (req, s) => {
      const [q, status, label, assignee] = ['q', 'status', 'label', 'assignee'].map((n) => param(req.url, n));
      const all = s.issues
        .filter(
          (/** @type {any} */ i) =>
            (!status || i.status === status) &&
            (!label || i.labels.includes(label)) &&
            (!assignee || i.assignee === assignee) &&
            matches(q, [i.key, i.title, i.body]),
        )
        .sort(
          (/** @type {any} */ a, /** @type {any} */ b) =>
            RANK(a.priority) - RANK(b.priority) || a.key.localeCompare(b.key, 'en', { numeric: true }),
        );
      const { items, pager } = paginate(all, req.url);
      const rows = items.map(
        (/** @type {any} */ i) =>
          html`<tr><td>${i.key}</td><td><a href="/issues/${i.key}">${i.title}</a>${i.labels.map((/** @type {string} */ l) => html` <span class="muted">[${l}]</span>`)}</td><td>${i.status}</td><td>${i.priority}</td><td>${i.assignee || 'Unassigned'}</td></tr>`,
      );
      const filters = html`${select('Status', 'status', [['', 'Any status'], ...STATUSES], status)}${select('Label', 'label', [['', 'Any label'], ...s.labels], label)}${select('Assignee', 'assignee', [['', 'Anyone'], ...s.members], assignee)}`;
      return view(
        req.url,
        'Issues',
        html`<h1>${s.project.name} issues</h1>${searchForm(q, 'Search issues', filters)}<p class="muted">${count(all.length, 'issue')}</p>
<table><thead><tr><th>Key</th><th>Title</th><th>Status</th><th>Priority</th><th>Assignee</th></tr></thead><tbody>${rowsOr(rows, 5)}</tbody></table>${pager}`,
      );
    },
  ],
  [
    'GET',
    '/issues/new',
    (req, s) => newIssue(req.url, s, { title: '', body: '', status: 'todo', priority: 'medium', assignee: '', labels: [] }),
  ],
  [
    'POST',
    '/issues',
    (req, s, _p, now) => {
      const { fields, files } = parseBody(req);
      const d = draftOf(fields, 'todo');
      const error = issueError(s, d);
      if (error) return invalid(newIssue(req.url, s, d, error));
      const key = freshId(s, s.project.key, (k) => !!find(s, k));
      const attachments = files.filter((f) => f.field === 'attach').map(({ name, type, data }) => ({ name, type, data }));
      s.issues.push({ key, ...d, comments: [], attachments });
      logEvent(s, 'created', { key, title: d.title }, now);
      for (const a of attachments) logEvent(s, 'attached', { key, name: a.name }, now);
      return redirect(withFlash(`/issues/${key}`, `Created ${key}.`));
    },
  ],
  [
    'GET',
    '/issues/:key',
    (req, s, p) => {
      const i = find(s, p.key);
      return i ? issuePage(req.url, s, i) : notFound('No such issue');
    },
  ],
  [
    'GET',
    '/issues/:key/edit',
    (req, s, p) => {
      const i = find(s, p.key);
      return i ? editIssue(req.url, s, i, i) : notFound('No such issue');
    },
  ],
  [
    'POST',
    '/issues/:key',
    (req, s, p, now) => {
      const i = find(s, p.key);
      if (!i) return notFound('No such issue');
      const d = draftOf(parseBody(req).fields, i.status);
      const error = issueError(s, d);
      if (error) return invalid(editIssue(req.url, s, i, d, error));
      const changes = applyChanges(i, d, ['title', 'body', 'priority', 'assignee', 'labels']);
      const fields = Object.keys(changes);
      if (fields.length) logEvent(s, 'updated', { key: i.key, fields, changes }, now);
      return redirect(withFlash(`/issues/${i.key}`, fields.length ? 'Issue saved.' : 'No changes.'));
    },
  ],
  [
    'POST',
    '/issues/:key/comments',
    (req, s, p, now) => {
      const i = find(s, p.key);
      if (!i) return notFound('No such issue');
      const body = (parseBody(req).fields.comment?.[0] ?? '').trim();
      if (!body) return invalid(issuePage(req.url, s, i, { error: 'Write a comment first.' }));
      i.comments.push({ author: s.user.name, body, at: new Date(now).toISOString() });
      logEvent(s, 'commented', { key: i.key, author: s.user.name, body }, now);
      return redirect(withFlash(`/issues/${i.key}`, 'Comment added.'));
    },
  ],
  [
    'POST',
    '/issues/:key/status',
    (req, s, p, now) => {
      const i = find(s, p.key);
      if (!i) return notFound('No such issue');
      const status = field(parseBody(req).fields, 'status');
      if (!STATUSES.includes(status)) return invalid(issuePage(req.url, s, i, { status, error: `Unknown status: ${status}` }));
      const from = i.status;
      if (from === status) return redirect(withFlash(`/issues/${i.key}`, `Already ${status}.`));
      i.status = status;
      logEvent(s, 'statusChanged', { key: i.key, from, to: status }, now);
      return redirect(withFlash(`/issues/${i.key}`, `Moved to ${status}.`));
    },
  ],
  [
    'GET',
    '/issues/:key/att/:n',
    (_req, s, p, now) => {
      const a = find(s, p.key)?.attachments[Number(p.n)];
      if (!a) return notFound('No such attachment');
      logEvent(s, 'downloaded', { key: p.key, name: a.name }, now);
      return bytes(a.name, a.type, a.data);
    },
  ],
];

/** @type {import('./server.mjs').App} */
export const tracker = {
  name: 'tracker',
  title: TITLE,
  init,
  handle(req, state, { now }) {
    const hit = route(req.method, req.url.pathname, ROUTES);
    return hit ? hit.handler(req, state, hit.params, now) : notFound();
  },
};
