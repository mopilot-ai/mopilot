// MoPilot 12-Grid Bench (#1381) team-wiki fixture (docs.localhost): spaces, page lists, search, pages with attachments,
// new and edited pages with revision history, comments and Markdown export; every change is in its state for graders.
import { pdfDoc } from '../../edgePages.mjs';
import { renderBody, snippet } from './docsMarkup.mjs';
import {
  bytes,
  download,
  field,
  flashOf,
  html,
  logEvent,
  nextId,
  notFound,
  ok,
  page,
  paginate,
  parseBody,
  redirect,
  route,
  withFlash,
} from './kit.mjs';

/** An attachment from a fixture: a PDF made from `pdf` lines, or text or base64 content. @param {any} a */
const attachment = (a) => {
  if (Array.isArray(a.pdf))
    return { name: String(a.name), type: 'application/pdf', data: Buffer.from(pdfDoc(a.pdf.map(String)), 'latin1').toString('base64') };
  return {
    name: String(a.name),
    type: String(a.type ?? 'application/octet-stream'),
    data: a.base64 ?? Buffer.from(String(a.text ?? ''), 'utf8').toString('base64'),
  };
};

/**
 * The wiki from a task's fixture: `{ user: { name }, spaces: [{ key, name }], pages: [{ id?, space, title, body,
 * updatedAt?, author?, attachments?: [{ name, type?, text? | base64? } | { name, pdf: string[] }] }] }`.
 * @param {any} f
 */
export function init(f) {
  const name = String(f?.user?.name ?? '').trim();
  if (!name) throw new Error('docs fixture needs user.name');
  if (!Array.isArray(f.spaces) || !f.spaces.length) throw new Error('docs fixture needs a spaces list');
  if (!Array.isArray(f.pages)) throw new Error('docs fixture needs a pages list');
  const spaces = f.spaces.map((/** @type {any} */ s) => ({ key: String(s.key ?? ''), name: String(s.name ?? s.key) }));
  if (spaces.some((/** @type {any} */ s) => !s.key)) throw new Error('every space needs a key');
  const state = { user: { name }, spaces, pages: /** @type {any[]} */ ([]), seq: 0, events: /** @type {any[]} */ ([]) };
  for (const p of f.pages) {
    if (!spaces.some((/** @type {any} */ s) => s.key === p.space)) throw new Error(`page "${p.title}" is in unknown space ${p.space}`);
    if (!String(p.title ?? '').trim()) throw new Error('every page needs a title');
    state.pages.push({
      id: p.id ?? nextId(state, 'PG'),
      space: p.space,
      title: String(p.title),
      body: String(p.body ?? ''),
      author: String(p.author ?? name),
      updatedAt: String(p.updatedAt ?? '2026-01-01T09:00:00Z'),
      attachments: (p.attachments ?? []).map(attachment),
      revisions: /** @type {any[]} */ ([]),
      comments: /** @type {any[]} */ ([]),
    });
  }
  return state;
}

const TITLE = 'Docs';
const NAV = /** @type {[string, string][]} */ ([
  ['/', 'Home'],
  ['/search', 'Search'],
  ['/new', 'New page'],
]);
const day = (/** @type {string} */ iso) => iso.slice(0, 16).replace('T', ' ');
const view = (/** @type {URL} */ url, /** @type {string} */ title, /** @type {unknown} */ body, error = '') =>
  ok(page({ app: TITLE, title, nav: NAV, flash: flashOf(url), error, body }));
const find = (/** @type {any} */ s, /** @type {string} */ id) => s.pages.find((/** @type {any} */ p) => p.id === id);
const spaceOf = (/** @type {any} */ s, /** @type {string} */ key) => s.spaces.find((/** @type {any} */ x) => x.key === key);
const newest = (/** @type {any} */ a, /** @type {any} */ b) => b.updatedAt.localeCompare(a.updatedAt);
const row = (/** @type {any} */ s, /** @type {any} */ p) =>
  html`<tr><td><a href="/p/${p.id}">${p.title}</a></td><td>${spaceOf(s, p.space).name}</td><td>${p.author}</td><td>${day(p.updatedAt)}</td></tr>`;
const table = (/** @type {unknown[]} */ rows) =>
  html`<table><thead><tr><th>Page</th><th>Space</th><th>Last edited by</th><th>Updated</th></tr></thead><tbody>${rows.length ? rows : html`<tr><td colspan="4">No pages yet.</td></tr>`}</tbody></table>`;

/** @type {[string, string, (req: any, s: any, p: Record<string, string>, now: number) => any][]} */
const ROUTES = [
  [
    'GET',
    '/',
    (req, s) => {
      const count = (/** @type {string} */ key) => s.pages.filter((/** @type {any} */ p) => p.space === key).length;
      const recent = [...s.pages].sort(newest).slice(0, 10);
      return view(
        req.url,
        'Home',
        html`<h1>Team wiki</h1><h2>Spaces</h2><ul>${s.spaces.map((/** @type {any} */ x) => html`<li><a href="/s/${x.key}">${x.name}</a> <span class="muted">(${count(x.key)} pages)</span></li>`)}</ul>
<h2>Recently updated</h2>${table(recent.map((/** @type {any} */ p) => row(s, p)))}`,
      );
    },
  ],
  [
    'GET',
    '/s/:key',
    (req, s, p) => {
      const space = spaceOf(s, p.key);
      if (!space) return notFound('No such space');
      const { items, pager } = paginate(s.pages.filter((/** @type {any} */ x) => x.space === space.key).sort(newest), req.url);
      return view(
        req.url,
        space.name,
        html`<h1>${space.name}</h1><p><a href="/new?space=${space.key}">New page in this space</a></p>${table(items.map((/** @type {any} */ x) => row(s, x)))}${pager}`,
      );
    },
  ],
  [
    'GET',
    '/search',
    (req, s) => {
      const raw = (req.url.searchParams.get('q') ?? '').trim();
      const q = raw.toLowerCase();
      const hits = q ? s.pages.filter((/** @type {any} */ x) => `${x.title}\n${x.body}`.toLowerCase().includes(q)).sort(newest) : [];
      const { items, pager } = paginate(hits, req.url);
      return view(
        req.url,
        'Search',
        html`<h1>Search</h1><form method="get" action="/search"><input type="search" name="q" value="${raw}" aria-label="Search pages" placeholder="Search pages"> <button>Search</button></form>
${q ? html`<p class="muted">${hits.length} result${hits.length === 1 ? '' : 's'}</p>` : ''}${items.map((/** @type {any} */ x) => html`<div class="card"><a href="/p/${x.id}"><strong>${x.title}</strong></a> <span class="muted">${spaceOf(s, x.space).name}</span><p>${snippet(x.body, q)}</p></div>`)}${pager}`,
      );
    },
  ],
  ['GET', '/new', (req, s) => editor(s, req.url, { space: req.url.searchParams.get('space') ?? '', title: '', body: '' })],
  [
    'POST',
    '/new',
    (req, s, _p, now) => {
      const { fields } = parseBody(req);
      const d = { space: field(fields, 'space'), title: field(fields, 'title'), body: fields.body?.[0] ?? '' };
      const error = !spaceOf(s, d.space) ? 'Choose a space.' : !d.title ? 'Give the page a title.' : '';
      if (error) return { ...editor(s, req.url, d, '', error), status: 422 };
      const id = nextId(s, 'PG');
      const at = new Date(now).toISOString();
      s.pages.push({ id, ...d, author: s.user.name, updatedAt: at, attachments: [], revisions: [], comments: [] });
      logEvent(s, 'created', { id, space: d.space, title: d.title }, now);
      return redirect(withFlash(`/p/${id}`, 'Page created.'));
    },
  ],
  [
    'GET',
    '/p/:id',
    (req, s, p, now) => {
      const pg = find(s, p.id);
      if (!pg) return notFound('No such page');
      logEvent(s, 'viewed', { id: pg.id }, now);
      return view(
        req.url,
        pg.title,
        html`<p class="muted"><a href="/s/${pg.space}">${spaceOf(s, pg.space).name}</a></p><div class="card"><h1>${pg.title}</h1>
<p class="muted">Last edited by ${pg.author} · ${day(pg.updatedAt)} · version ${pg.revisions.length + 1}</p>${renderBody(pg.body)}
${pg.attachments.length ? html`<p><strong>Attachments:</strong> ${pg.attachments.map((/** @type {any} */ a, /** @type {number} */ i) => html`<a href="/p/${pg.id}/att/${i}">${a.name}</a> `)}</p>` : ''}</div>
<p><a href="/p/${pg.id}/edit">Edit</a> · <a href="/p/${pg.id}/history">History</a> · <a href="/p/${pg.id}/export.md">Export as Markdown</a></p>
<h2>Comments</h2>${pg.comments.map((/** @type {any} */ c) => html`<div class="card"><strong>${c.author}</strong> <span class="muted">${day(c.at)}</span><pre class="body">${c.text}</pre></div>`)}
<form method="post" action="/p/${pg.id}/comment"><label for="comment">Add a comment</label><textarea id="comment" name="text"></textarea><p><button>Comment</button></p></form>`,
      );
    },
  ],
  [
    'GET',
    '/p/:id/att/:i',
    (_req, s, p, now) => {
      const a = find(s, p.id)?.attachments[Number(p.i)];
      if (!a) return notFound('No such attachment');
      logEvent(s, 'downloaded', { id: p.id, name: a.name }, now);
      return bytes(a.name, a.type, a.data, a.type === 'application/pdf');
    },
  ],
  [
    'GET',
    '/p/:id/edit',
    (req, s, p) => {
      const pg = find(s, p.id);
      return pg ? editor(s, req.url, pg, pg.id) : notFound('No such page');
    },
  ],
  [
    'POST',
    '/p/:id/edit',
    (req, s, p, now) => {
      const pg = find(s, p.id);
      if (!pg) return notFound('No such page');
      const { fields } = parseBody(req);
      const d = { space: pg.space, title: field(fields, 'title'), body: fields.body?.[0] ?? '' };
      if (!d.title) return { ...editor(s, req.url, d, pg.id, 'Give the page a title.'), status: 422 };
      pg.revisions.push({ title: pg.title, body: pg.body, at: pg.updatedAt, author: pg.author });
      Object.assign(pg, { title: d.title, body: d.body, author: s.user.name, updatedAt: new Date(now).toISOString() });
      logEvent(s, 'edited', { id: pg.id, revision: pg.revisions.length + 1 }, now);
      return redirect(withFlash(`/p/${pg.id}`, 'Page saved.'));
    },
  ],
  [
    'GET',
    '/p/:id/history',
    (req, s, p) => {
      const pg = find(s, p.id);
      if (!pg) return notFound('No such page');
      const versions = [...pg.revisions, { title: pg.title, body: pg.body, at: pg.updatedAt, author: pg.author }]
        .map((r, i) => ({ ...r, n: i + 1 }))
        .reverse();
      return view(
        req.url,
        `History · ${pg.title}`,
        html`<h1>History of <a href="/p/${pg.id}">${pg.title}</a></h1>${versions.map(
          (r) =>
            html`<div class="card"><strong>Version ${r.n}</strong>${r.n === versions.length ? ' (current)' : ''} <span class="muted">${r.author} · ${day(r.at)}</span><h3>${r.title}</h3><pre class="body">${r.body}</pre></div>`,
        )}`,
      );
    },
  ],
  [
    'POST',
    '/p/:id/comment',
    (req, s, p, now) => {
      const pg = find(s, p.id);
      if (!pg) return notFound('No such page');
      const text = field(parseBody(req).fields, 'text');
      if (!text) return redirect(withFlash(`/p/${pg.id}`, 'Write a comment first.'));
      pg.comments.push({ author: s.user.name, text, at: new Date(now).toISOString() });
      logEvent(s, 'commented', { id: pg.id, text }, now);
      return redirect(withFlash(`/p/${pg.id}`, 'Comment added.'));
    },
  ],
  [
    'GET',
    '/p/:id/export.md',
    (_req, s, p, now) => {
      const pg = find(s, p.id);
      if (!pg) return notFound('No such page');
      logEvent(s, 'exported', { id: pg.id }, now);
      const file = `${pg.title.replace(/[^\w-]+/g, '-').replace(/^-+|-+$/g, '') || pg.id}.md`;
      return download(file, 'text/markdown; charset=utf-8', `# ${pg.title}\n\n${pg.body}\n`);
    },
  ],
];

/** The new-page or edit form; `id` names the page being edited. @param {any} s @param {URL} url @param {{ space: string, title: string, body: string }} d */
function editor(s, url, d, id = '', error = '') {
  return view(
    url,
    id ? `Edit ${d.title}` : 'New page',
    html`<h1>${id ? 'Edit page' : 'New page'}</h1><form method="post" action="${id ? `/p/${id}/edit` : '/new'}">
${id ? '' : html`<label for="space">Space</label><select id="space" name="space"><option value="">Choose a space</option>${s.spaces.map((/** @type {any} */ x) => html`<option value="${x.key}"${x.key === d.space ? html` selected` : ''}>${x.name}</option>`)}</select>`}
<label for="title">Title</label><input id="title" name="title" size="60" value="${d.title}">
<label for="body">Content</label><textarea id="body" name="body">${d.body}</textarea>
<p class="muted"># Heading, ## Subheading, - bullet, [text](https://link)</p><p><button>Save</button></p></form>`,
    error,
  );
}

/** @type {import('./server.mjs').App} */
export const docs = {
  name: 'docs',
  title: TITLE,
  init,
  handle(req, state, { now }) {
    const hit = route(req.method, req.url.pathname, ROUTES);
    return hit ? hit.handler(req, state, hit.params, now) : notFound();
  },
};
