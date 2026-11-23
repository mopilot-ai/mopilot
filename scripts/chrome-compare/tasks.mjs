// The Chrome comparison's tasks (design D5): local fixture pages, the prompt each arm's chat gets, and a checker that reads what the page server recorded and the final answer.
//
// Every page is served by the comparison's own loopback server (server.mjs), so a run never depends on
// the internet and every outcome is checked on the server side: what a form posted, what file arrived,
// which dialog answer came back. The iframe task serves its frame from a second origin (the server's
// other port). The signed-in task is optional: the runner signs the scratch profile in first.

/** Escapes text for HTML. */
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const page = (title, body, script = '') =>
  `<!doctype html><html><head><meta charset="utf-8"><title>${esc(title)}</title></head><body>${body}${script ? `<script>${script}</script>` : ''}</body></html>`;
/** A form that posts JSON to `action` and shows "Saved" when the server took it. */
const postScript = (formId, action) =>
  `document.getElementById(${JSON.stringify(formId)}).addEventListener('submit', async (e) => { e.preventDefault(); const data = Object.fromEntries(new FormData(e.target)); const r = await fetch(${JSON.stringify(action)}, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(data) }); document.body.insertAdjacentHTML('beforeend', r.ok ? '<p id="saved">Saved</p>' : '<p>Failed</p>'); });`;

const LONG_FORM = [
  ['first', 'First name', 'Ada'],
  ['last', 'Last name', 'Lovelace'],
  ['email', 'Email', 'ada@example.test'],
  ['phone', 'Phone', '555-0100'],
  ['street', 'Street', '12 Analytical Way'],
  ['city', 'City', 'London'],
  ['zip', 'Postal code', 'NW1 6XE'],
  ['country', 'Country', 'United Kingdom'],
  ['company', 'Company', 'Engines Ltd'],
  ['role', 'Role', 'Mathematician'],
  ['referral', 'How did you hear about us', 'A friend'],
  ['notes', 'Notes', 'Prefers email'],
];

/**
 * The tasks: `pages(o)` maps a path to a page (o.frameOrigin is the second origin), `prompt(o)` is what
 * the user asks (o.base is the first origin, o.uploadFile the file to upload), and `check(rec, answer, o)`
 * says whether it was done, from what the server recorded (`rec`: path -> posted bodies) and the answer.
 * @type {{ id: string, title: string, optional?: boolean,
 *          pages: (o: { frameOrigin: string }) => Record<string, string | { type: string, disposition: string, body: string }>,
 *          prompt: (o: { base: string, uploadFile: string }) => string,
 *          check: (rec: Record<string, any[]>, answer: string, o: { uploadFile: string }) => boolean }[]}
 */
export const TASKS = [
  {
    id: 'lookup',
    title: 'Multi-page lookup',
    pages: () => ({
      '/lookup': page('Library', '<h1>Library</h1><a href="/lookup/shelf">Go to the shelf</a>'),
      '/lookup/shelf': page('Shelf', '<h1>Shelf</h1><ul><li><a href="/lookup/book">The Difference Engine</a></li><li>Other book</li></ul>'),
      '/lookup/book': page('The Difference Engine', '<h1>The Difference Engine</h1><p>Catalogue code: <b>DE-4471</b></p>'),
    }),
    prompt: ({ base }) =>
      `In my Chrome, open ${base}/lookup, find the book "The Difference Engine" and tell me its catalogue code. Answer with the code.`,
    check: (_rec, answer) => /DE-4471/.test(answer),
  },
  {
    id: 'long-form',
    title: 'Long form',
    pages: () => ({
      '/form': page(
        'Sign up',
        `<h1>Sign up</h1><form id="f">${LONG_FORM.map(([n, l]) => `<label>${esc(l)} <input name="${n}"></label><br>`).join('')}<button>Submit</button></form>`,
        postScript('f', '/form'),
      ),
    }),
    prompt: ({ base }) =>
      // each value in quotes: the last one is followed by a sentence's period, which is not part of it
      `In my Chrome, open ${base}/form and fill in the sign-up form with these values (without the quotes): ${LONG_FORM.map(([, l, v]) => `${l}: "${v}"`).join('; ')}. Then submit it.`,
    check: (rec) => {
      const got = rec['/form']?.at(-1);
      return !!got && LONG_FORM.every(([n, , v]) => String(got[n] ?? '').trim() === v);
    },
  },
  {
    id: 'spa',
    title: 'Single-page app',
    pages: () => ({
      '/spa': page(
        'Settings app',
        '<nav><a href="#/home">Home</a> <a href="#/settings">Settings</a></nav><main id="view"></main>',
        `const view = document.getElementById('view');
function render() {
  if (location.hash === '#/settings') {
    view.innerHTML = '<h1>Settings</h1><button id="adv">Advanced</button><div id="advanced" hidden><label>Theme <select id="theme"><option>light</option><option>dark</option><option>solarized</option></select></label><button id="save">Save</button></div>';
    document.getElementById('adv').onclick = () => { document.getElementById('advanced').hidden = false; };
    document.getElementById('save').onclick = async () => { await fetch('/spa/save', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ theme: document.getElementById('theme').value }) }); view.insertAdjacentHTML('beforeend', '<p>Saved</p>'); };
  } else view.innerHTML = '<h1>Home</h1><p>Welcome.</p>';
}
addEventListener('hashchange', render); render();`,
      ),
    }),
    prompt: ({ base }) =>
      `In my Chrome, open ${base}/spa, go to Settings, open the advanced settings, set the theme to solarized and save.`,
    check: (rec) => rec['/spa/save']?.at(-1)?.theme === 'solarized',
  },
  {
    id: 'two-tabs',
    title: 'Two-tab compare',
    pages: () => ({
      '/shop/a': page('Kettle A', '<h1>Kettle A</h1><p>Price: <b>$41.90</b></p>'),
      '/shop/b': page('Kettle B', '<h1>Kettle B</h1><p>Price: <b>$38.50</b></p>'),
    }),
    prompt: ({ base }) =>
      `In my Chrome, open ${base}/shop/a and ${base}/shop/b in two tabs, compare the prices and tell me which kettle is cheaper. Answer "Kettle A" or "Kettle B".`,
    check: (_rec, answer) => /Kettle B/.test(answer) && !/Kettle A is cheaper/i.test(answer),
  },
  {
    id: 'upload',
    title: 'File upload',
    pages: () => ({
      '/upload': page(
        'Upload',
        '<h1>Upload a receipt</h1><form id="u"><input type="file" name="file"><button>Send</button></form>',
        `document.getElementById('u').addEventListener('submit', async (e) => { e.preventDefault(); const f = e.target.file.files[0]; const r = await fetch('/upload', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: f && f.name, text: f ? await f.text() : '' }) }); document.body.insertAdjacentHTML('beforeend', r.ok ? '<p>Received</p>' : '<p>Failed</p>'); });`,
      ),
    }),
    prompt: ({ base, uploadFile }) => `In my Chrome, open ${base}/upload, upload the file ${uploadFile} and send it.`,
    check: (rec, _answer, { uploadFile }) => {
      const got = rec['/upload']?.at(-1);
      return !!got && got.name === uploadFile.split(/[\\/]/).pop() && /receipt-7731/.test(String(got.text));
    },
  },
  {
    id: 'dialog',
    title: 'Dialog',
    pages: () => ({
      '/dialog': page(
        'Archive',
        '<h1>Old project</h1><button id="archive">Archive project</button>',
        `document.getElementById('archive').onclick = async () => { const ok = confirm('Archive "Old project"?'); await fetch('/dialog', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ accepted: ok }) }); document.body.insertAdjacentHTML('beforeend', ok ? '<p>Archived</p>' : '<p>Kept</p>'); };`,
      ),
    }),
    prompt: ({ base }) => `In my Chrome, open ${base}/dialog and archive the project (confirm when asked).`,
    check: (rec) => rec['/dialog']?.at(-1)?.accepted === true,
  },
  {
    id: 'iframe',
    title: 'Cross-origin iframe',
    pages: ({ frameOrigin }) => ({
      '/iframe': page('Checkout', `<h1>Checkout</h1><iframe src="${esc(frameOrigin)}/iframe/frame" width="600" height="200"></iframe>`),
      '/iframe/frame': page(
        'Coupon',
        '<form id="c"><label>Coupon code <input name="coupon"></label><button>Apply</button></form>',
        postScript('c', '/iframe'),
      ),
    }),
    prompt: ({ base }) => `In my Chrome, open ${base}/iframe and apply the coupon code SPRING26 in the checkout's coupon box.`,
    check: (rec) => rec['/iframe']?.at(-1)?.coupon === 'SPRING26',
  },
  {
    id: 'signed-in',
    title: 'Signed-in page',
    optional: true,
    pages: () => ({
      '/account': page(
        'Account',
        '<h1>Account</h1><p id="who"></p>',
        `fetch('/whoami').then((r) => r.json()).then((j) => { document.getElementById('who').textContent = j.user ? 'Signed in as ' + j.user + ', member number ' + j.member : 'Not signed in'; });`,
      ),
    }),
    prompt: ({ base }) => `In my Chrome, open ${base}/account and tell me my member number.`,
    check: (_rec, answer) => /M-20931/.test(answer),
  },
  {
    // a link with target=_blank opens a second tab the chat has to find (#1642)
    id: 'blank',
    title: 'target=_blank link',
    optional: true,
    pages: () => ({
      '/blank': page('Parcels', '<h1>Parcels</h1><a href="/blank/detail" target="_blank">Open the locker details</a>'),
      '/blank/detail': page('Locker details', '<h1>Locker details</h1><p>Locker code: <b>LK-5520</b></p>'),
    }),
    prompt: ({ base }) =>
      `In my Chrome, open ${base}/blank, click the link "Open the locker details" (it opens in a new tab) and tell me the locker code. Answer with the code.`,
    check: (_rec, answer) => /LK-5520/.test(answer),
  },
  {
    // a file the browser downloads; the server records that it was fetched
    id: 'download',
    title: 'File download',
    optional: true,
    pages: () => ({
      '/download': page('Reports', '<h1>Reports</h1><a id="dl" href="/download/report.csv">Download the Q3 report</a>'),
      '/download/report.csv': { type: 'text/csv', disposition: 'attachment; filename="report-q3.csv"', body: 'item,total\nkettle,41.90\n' },
    }),
    prompt: ({ base }) => `In my Chrome, open ${base}/download and download the Q3 report.`,
    check: (rec) => (rec['/download/report.csv']?.length ?? 0) > 0,
  },
  {
    // the target sits far below the first screen
    id: 'scroll',
    title: 'Page needing a scroll',
    optional: true,
    pages: () => ({
      '/scroll': page(
        'Terms',
        `<h1>Terms of service</h1>${Array.from({ length: 60 }, (_, i) => `<p>Clause ${i + 1}: lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor incididunt ut labore.</p>`).join('')}<button id="accept">Accept the terms</button>`,
        `document.getElementById('accept').onclick = async () => { await fetch('/scroll', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ accepted: true }) }); document.body.insertAdjacentHTML('beforeend', '<p>Accepted</p>'); };`,
      ),
    }),
    prompt: ({ base }) => `In my Chrome, open ${base}/scroll, scroll to the bottom of the terms and click "Accept the terms".`,
    check: (rec) => rec['/scroll']?.at(-1)?.accepted === true,
  },
  {
    // a screenshot of a Chrome page as a form's file (#1539): the page reports the image it was given, decoded
    id: 'screenshot-upload',
    title: 'Screenshot upload',
    optional: true,
    pages: () => ({
      '/shot/invoice': page('Invoice 4471', '<h1>Invoice 4471</h1><p>Amount due: <b>$12.40</b></p><p>Due by 30 November.</p>'),
      '/shot/report': page(
        'Report a billing problem',
        '<h1>Report a billing problem</h1><form id="s"><label>Screenshot of the invoice <input type="file" name="shot" accept="image/*"></label><button>Send report</button></form>',
        `document.getElementById('s').addEventListener('submit', async (e) => { e.preventDefault(); const f = e.target.shot.files[0]; let width = 0, height = 0; try { const b = await createImageBitmap(f); width = b.width; height = b.height; } catch {} const head = f ? [...new Uint8Array(await f.slice(0, 4).arrayBuffer())].map((x) => x.toString(16).padStart(2, '0')).join('') : ''; const r = await fetch('/shot/report', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: f && f.name, type: f && f.type, size: f ? f.size : 0, head, width, height }) }); document.body.insertAdjacentHTML('beforeend', r.ok ? '<p>Report sent</p>' : '<p>Failed</p>'); });`,
      ),
    }),
    prompt: ({ base }) =>
      `In my Chrome, open ${base}/shot/invoice and take a screenshot of that page. Then open ${base}/shot/report in my Chrome, attach that screenshot as the image file and send the report.`,
    check: (rec) => {
      const got = rec['/shot/report']?.at(-1);
      // a JPEG or PNG the page could decode, at least a small page's size
      return !!got && /^(ffd8ff|89504e47)/.test(String(got.head)) && got.width >= 200 && got.height >= 100;
    },
  },
];

/** The upload task's file content (the runner writes it to the chat's upload folder). */
export const UPLOAD_TEXT = 'receipt-7731\nTotal: 12.40\n';
/** The signed-in task's account (the server's /whoami answers it once the scratch profile signed in). */
export const ACCOUNT = Object.freeze({ user: 'tester', member: 'M-20931' });

/**
 * The tasks a run includes: all required ones, the optional ones only when asked, or the ids named.
 * @param {{ ids?: string[] | null, optional?: boolean }} [o]
 */
export function selectTasks({ ids = null, optional = false } = {}) {
  if (ids && ids.length) {
    const unknown = ids.filter((id) => !TASKS.some((t) => t.id === id));
    if (unknown.length) throw new Error(`Unknown task: ${unknown.join(', ')}`);
    return TASKS.filter((t) => ids.includes(t.id));
  }
  return TASKS.filter((t) => optional || !t.optional);
}

/** Every page of the given tasks, by path. */
export function fixturePages(tasks, o) {
  return Object.assign({}, ...tasks.map((t) => t.pages(o)));
}
