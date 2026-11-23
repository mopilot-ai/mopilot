// MoPilot desktop, site and takeover approval interactions.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { act, createElement, f, Approvals, mount, nativeRequest, press, personClick, window } from './fixture';

export function registerHostApprovalsCases() {
  /* ------------------------------ Approvals: MoPilot's own computer and browser cards ------------------------------ */

  /** A click or key press from a person (React reads isTrusted from the native event). */
  const answers = () => f.calls.filter((c: any[]) => c[0] === 'answer').map((c: any[]) => c.slice(1));

  async function sageCard(params: any, { requests = [] as any[] } = {}) {
    f.requests = requests;
    f.session = { approvals: [{ id: 'sa-1', method: 'sage/approval', params }] };
    f.state = { segments: {}, runtime: {} };
    f.calls = [];
    return mount(createElement(Approvals, { threadId: 'chat', cwd: '/project' }));
  }

  test("the approval stack shows a harness request first, then a desktop access card or MoPilot's other cards", async () => {
    let m = await sageCard({ kind: 'computerAccessSet', apps: [] }, { requests: [nativeRequest()] });
    try {
      assert.equal(m.host.querySelector('.approval-title')?.textContent, 'Allow Codex to use Safari?');
      assert.equal(m.host.querySelector('.approval-queue')?.textContent, '1 more waiting');
    } finally {
      await m.close();
    }
    for (const [kind, desktop] of [
      ['computerAccessSet', true],
      ['computerTakeover', true],
      ['computerAccess', false],
    ] as const) {
      m = await sageCard({ kind, app: { name: 'Notes' }, apps: [{ bundleId: 'com.apple.Notes', name: 'Notes', tier: 'full' }] });
      try {
        const card = m.host.querySelector('.approval-card')!;
        assert.equal(card.getAttribute('data-kind'), kind);
        assert.equal(card.classList.contains('desktop-access'), desktop, kind);
        assert.equal(m.host.querySelector('.approval-queue') === null, true);
      } finally {
        await m.close();
      }
    }
    f.requests = [];
    f.session = { approvals: [] };
    m = await mount(createElement(Approvals, { threadId: 'chat', cwd: '/project' }));
    try {
      assert.equal(m.host.innerHTML, '');
    } finally {
      await m.close();
    }
  });

  test('a dev server card asks to run the command in its folder: Allow in this chat (Enter, 1, a click) or Deny (Esc)', async () => {
    const m = await sageCard({ kind: 'devServer', harness: 'claude', command: 'npm run dev', cwd: '/project/web' });
    try {
      assert.equal(m.host.querySelector('.approval-card')!.getAttribute('data-kind'), 'devServer');
      assert.equal(m.host.querySelector('.approval-message')?.textContent, 'Allow Claude Code to start a dev server?');
      assert.equal(m.host.querySelector('p.sage-access-hint[title="/project/web"] > code')?.textContent, 'npm run dev');
      assert.deepEqual(
        [...m.host.querySelectorAll('.approval-foot button')].map((b: any) => b.textContent),
        ['Deny Esc', 'Allow in this chat ⏎'],
      );
      const input = document.createElement('input');
      document.body.append(input);
      await press('Enter', input);
      input.remove();
      const layer = document.createElement('div');
      layer.className = 'popover-layer';
      document.body.append(layer);
      await press('Enter');
      layer.remove();
      await press('q');
      await act(async () => {
        m.button('Allow in this chat ⏎').click();
      });
      assert.deepEqual(answers(), [], 'a synthetic click is not a person');
      await press('Enter');
      await press('1');
      await personClick(m.button('Allow in this chat ⏎'));
      await press('Escape');
      await personClick(m.button('Deny Esc'));
      assert.deepEqual(answers(), [
        ['sa-1', { decision: 'allow', scope: 'chat' }],
        ['sa-1', { decision: 'allow', scope: 'chat' }],
        ['sa-1', { decision: 'allow', scope: 'chat' }],
        ['sa-1', { decision: 'deny' }],
        ['sa-1', { decision: 'deny' }],
      ]);
    } finally {
      await m.close();
    }
  });

  test('a terminal card (open_terminal_tab) asks to open a shell in its folder, with the same answers', async () => {
    const m = await sageCard({ kind: 'terminalTab', harness: 'claude', cwd: '/project/web' });
    try {
      assert.equal(m.host.querySelector('.approval-card')!.getAttribute('data-kind'), 'terminalTab');
      assert.equal(m.host.querySelector('.approval-kind span')?.textContent, 'Terminal');
      assert.equal(m.host.querySelector('.approval-message')?.textContent, 'Allow Claude Code to open a terminal?');
      assert.equal(m.host.querySelector('p.sage-access-hint[title="/project/web"] > code')?.textContent, '/project/web');
      await press('Enter');
      assert.deepEqual(answers(), [['sa-1', { decision: 'allow', scope: 'chat' }]]);
    } finally {
      await m.close();
    }
  });

  test('a host question card (hostAsk) shows its details and a button per choice; destructive ones answer to a click only', async () => {
    const choices = [
      { id: 'new', label: 'New branch' },
      { id: 'stay', label: 'Stay on main' },
    ];
    let m = await sageCard({
      kind: 'hostAsk',
      harness: 'codex',
      title: 'Branch',
      message: 'Where should the changes go?',
      details: ['New branch: fix/a'],
      choices,
    });
    try {
      assert.equal(m.host.querySelector('.approval-card')!.getAttribute('data-kind'), 'hostAsk');
      assert.equal(m.host.querySelector('.approval-kind span')?.textContent, 'Branch');
      assert.equal(m.host.querySelector('.approval-message')?.textContent, 'Where should the changes go?');
      assert.equal(m.host.querySelector('p.sage-access-hint[title="New branch: fix/a"] > code')?.textContent, 'New branch: fix/a');
      assert.deepEqual(
        [...m.host.querySelectorAll('.approval-foot button')].map((b: any) => b.textContent),
        ['Deny Esc', 'New branch ⏎', 'Stay on main 2'],
      );
      // keys typed into a field or with a menu open are not answers
      const input = document.createElement('input');
      document.body.append(input);
      await press('Enter', input);
      input.remove();
      const layer = document.createElement('div');
      layer.className = 'popover-layer';
      document.body.append(layer);
      await press('Enter');
      layer.remove();
      await press('2');
      await press('3');
      await press('Enter');
      await press('Escape');
      await personClick(m.button('Stay on main 2'));
      assert.deepEqual(answers(), [
        ['sa-1', { decision: 'allow', choice: 'stay' }],
        ['sa-1', { decision: 'allow', choice: 'new' }],
        ['sa-1', { decision: 'deny' }],
        ['sa-1', { decision: 'allow', choice: 'stay' }],
      ]);
    } finally {
      await m.close();
    }
    m = await sageCard({
      kind: 'hostAsk',
      harness: 'codex',
      title: 'Remove worktrees',
      message: 'Remove 2 worktrees?',
      choices: [{ id: 'allow', label: 'Remove' }],
      destructive: true,
    });
    try {
      assert.deepEqual(
        [...m.host.querySelectorAll('.approval-foot button')].map((b: any) => b.textContent),
        ['Deny Esc', 'Remove '],
      );
      await press('1');
      await press('Enter');
      assert.deepEqual(answers(), [], 'no key allows a destructive question');
      await press('Escape');
      await personClick(m.button('Remove'));
      assert.deepEqual(answers(), [
        ['sa-1', { decision: 'deny' }],
        ['sa-1', { decision: 'allow', choice: 'allow' }],
      ]);
    } finally {
      await m.close();
    }
    // a card with no choices can only be denied
    m = await sageCard({ kind: 'hostAsk', harness: 'codex', title: 'Branch', message: 'Nothing to pick' });
    try {
      await press('Enter');
      await press('1');
      assert.deepEqual(answers(), []);
    } finally {
      await m.close();
    }
  });

  test('a browser site card without "Always allow" takes 1 and 2 only; with it, 3 and its button allow always', async () => {
    let m = await sageCard({ kind: 'browserOrigin', origin: 'http://localhost:3000', allowAlways: false });
    try {
      const labels = [...m.host.querySelectorAll('.approval-foot button')].map((b: any) => b.textContent);
      // Allow in this chat is the primary where Always allow isn't offered; Allow once is in its menu
      assert.deepEqual(labels, ['Deny Esc', 'Allow in this chat 2', '', 'Allow once']);
      assert.equal(m.host.querySelector('.approval-message')?.textContent, 'Allow Codex to use http://localhost:3000?');
      await press('3');
      assert.deepEqual(answers(), []);
      await press('2');
      assert.deepEqual(answers(), [['sa-1', { decision: 'allow', scope: 'chat', level: undefined }]]);
    } finally {
      await m.close();
    }
    m = await sageCard({ kind: 'computerAccess', app: { name: 'Notes' } });
    try {
      await press('3');
      assert.deepEqual(answers(), [['sa-1', { decision: 'allow', scope: 'always', level: undefined }]]);
      await personClick(m.button('Always allow ⇧⌘⏎'));
      assert.deepEqual(answers()[1], ['sa-1', { decision: 'allow', scope: 'always', level: undefined }]);
    } finally {
      await m.close();
    }
    // an action that can't be undone offers only "Allow once", with no menu and no scope line
    m = await sageCard({ kind: 'computerConfirm', app: { name: 'Mail' }, verb: 'send', summary: 'an email' });
    try {
      assert.deepEqual(
        [...m.host.querySelectorAll('.approval-foot button')].map((b: any) => b.textContent),
        ['Deny Esc', 'Allow once hold ⌘⏎'],
      );
      assert.equal(m.host.querySelector('.approval-explain'), null);
      assert.equal(m.host.querySelector('.approval-message')?.textContent, "Allow Codex to send in Mail? This can't be undone.");
      assert.equal(m.host.querySelector('.sage-access-hint')?.textContent, 'an email');
    } finally {
      await m.close();
    }
  });

  test('a risky site says its risk class and why: a high-risk site card has no "Always allow", and a per-action card says it too', async () => {
    const risk = {
      level: 'high',
      category: 'banking',
      label: 'Banking site',
      explanation: "This is a financial site. The agent won't transfer funds, pay or trade for you.",
      financial: true,
      credentials: false,
    };
    let m = await sageCard({ kind: 'browserOrigin', origin: 'https://www.chase.com', allowAlways: false, risk });
    try {
      const note = m.host.querySelector('.approval-risk');
      assert.equal(note?.textContent, "Banking site. This is a financial site. The agent won't transfer funds, pay or trade for you.");
      assert.equal(note?.getAttribute('data-level'), 'high');
      assert.equal(note?.getAttribute('data-category'), 'banking');
      assert.equal(note?.getAttribute('role'), 'note');
      assert.deepEqual(
        [...m.host.querySelectorAll('.approval-foot button')].map((b: any) => b.textContent),
        ['Deny Esc', 'Allow in this chat 2', '', 'Allow once'],
      );
      // a high-risk site offers no Always allow, so its primary names nowhere it is saved
      assert.equal(m.host.querySelector('.approval-explain'), null);
      assert.equal(m.host.querySelector('.ap-btn.allow')?.hasAttribute('title'), false);
    } finally {
      await m.close();
    }
    m = await sageCard({
      kind: 'computerConfirm',
      app: { name: 'https://user@site.test' },
      verb: 'act on a high-risk site',
      summary: 'click',
      risk: { ...risk, level: 'normal', category: null, label: 'Sign-in details in the address', explanation: 'It asks every time.' },
    });
    try {
      assert.equal(m.host.querySelector('.approval-risk')?.textContent, 'Sign-in details in the address. It asks every time.');
      assert.equal(m.host.querySelector('.approval-risk')?.hasAttribute('data-category'), false);
    } finally {
      await m.close();
    }
    // no label: nothing to say
    m = await sageCard({ kind: 'browserOrigin', origin: 'https://example.test', risk: { ...risk, label: '' } });
    try {
      assert.equal(m.host.querySelector('.approval-risk'), null);
    } finally {
      await m.close();
    }
  });

  test('a browser site card lets the person give less than asked: Read only on a read-and-write ask, by click or then a key; an app card still cannot go lower', async () => {
    const levels = [
      { id: 'read', label: 'Read only' },
      { id: 'write', label: 'Read and write' },
    ];
    const risk = {
      level: 'high',
      category: 'banking',
      label: 'Banking site',
      explanation: 'A financial site.',
      financial: true,
      credentials: false,
    };
    let m = await sageCard({ kind: 'browserOrigin', origin: 'https://bank.test', level: 'write', levels, allowAlways: false, risk });
    try {
      const radios = () => [...m.host.querySelectorAll('.sage-levels button')] as any[];
      assert.deepEqual(
        radios().map((b) => [b.textContent, b.disabled, b.getAttribute('aria-checked')]),
        [
          ['Read only', false, 'false'],
          ['Read and write', false, 'true'],
        ],
      );
      assert.equal(m.host.querySelector('.sage-access-lower'), null, 'nothing lowered yet');
      // the risk warning and the missing "Always allow" stay
      assert.equal(m.host.querySelector('.approval-risk')?.textContent, 'Banking site. A financial site.');
      assert.deepEqual(
        [...m.host.querySelectorAll('.approval-foot button')].map((b: any) => b.textContent),
        ['Deny Esc', 'Allow in this chat 2', '', 'Allow once'],
      );
      // a synthetic click changes nothing
      await act(async () => {
        radios()[0].click();
      });
      assert.equal(radios()[0].getAttribute('aria-checked'), 'false');
      await personClick(radios()[0]);
      assert.equal(radios()[0].getAttribute('aria-checked'), 'true');
      assert.equal(m.host.querySelector('.sage-access-lower')?.textContent, 'It asks again before clicking or typing.');
      await personClick(m.button('Allow once'));
      await press('2');
      assert.deepEqual(answers(), [
        ['sa-1', { decision: 'allow', scope: 'once', level: 'read' }],
        ['sa-1', { decision: 'allow', scope: 'chat', level: 'read' }],
      ]);
      // back up to what was asked: the note goes and the answer carries write
      await personClick(radios()[1]);
      assert.equal(m.host.querySelector('.sage-access-lower'), null);
      await press('1');
      assert.deepEqual(answers().at(-1), ['sa-1', { decision: 'allow', scope: 'once', level: 'write' }]);
    } finally {
      await m.close();
    }
    // a site card asking for read only has nothing lower to note
    m = await sageCard({ kind: 'browserOrigin', origin: 'https://a.test', level: 'read', levels });
    try {
      // no helper line under the levels; what each level allows is the radiogroup's tooltip
      assert.equal(m.host.querySelector('.sage-access-hint'), null);
      assert.equal(
        (m.host.querySelector('.sage-levels') as HTMLElement).title,
        'Read and write also clicks and types. This site and port.',
      );
      await personClick(m.host.querySelectorAll('.sage-levels button')[1]);
      assert.equal(m.host.querySelector('.sage-access-hint'), null);
      await personClick(m.host.querySelectorAll('.sage-levels button')[0]);
      assert.equal(m.host.querySelector('.sage-access-lower'), null);
      await personClick(m.host.querySelectorAll('.sage-levels button')[1]);
      assert.equal(m.host.querySelector('.sage-access-lower'), null);
    } finally {
      await m.close();
    }
    // an app card keeps the levels below the one the call needs out of reach
    m = await sageCard({ kind: 'computerAccess', app: { name: 'Notes' }, level: 'write', levels });
    try {
      assert.deepEqual(
        [...m.host.querySelectorAll('.sage-levels button')].map((b: any) => b.disabled),
        [true, false],
      );
      assert.equal(m.host.querySelector('.sage-access-hint'), null);
    } finally {
      await m.close();
    }
  });

  const deskApps = [
    { bundleId: 'com.apple.Notes', name: 'Notes', tier: 'full', tierLabel: 'Full control' },
    { bundleId: 'com.apple.Terminal', name: 'Terminal', tier: 'click', warning: 'Terminal can run any command' },
  ];

  test('a desktop access card lists the apps with their tiers, warnings, extras and the apps never granted', async () => {
    const m = await sageCard({
      kind: 'computerAccessSet',
      apps: deskApps,
      reason: 'to take notes',
      clipboardRead: true,
      clipboardWrite: true,
      systemKeyCombos: true,
      denied: [{ name: 'Keychain Access', reason: 'never granted' }],
    });
    try {
      assert.equal(
        m.host.querySelector('.approval-message')?.textContent,
        'Allow Codex to use Notes and Terminal and read the clipboard, write the clipboard and press whole-Mac shortcuts?',
      );
      assert.equal(m.host.querySelector('.desktop-access-warning')?.textContent, ' Terminal: Terminal can run any command');
      assert.deepEqual(
        [...m.host.querySelectorAll('.desktop-access-apps li')].map((li: any) => [
          li.querySelector('.desktop-access-name').textContent,
          li.querySelector('.desktop-access-tier').textContent,
        ]),
        [
          ['Notes', 'Full control'],
          ['Terminal', 'click'],
        ],
      );
      assert.deepEqual(
        [...m.host.querySelectorAll('.desktop-access-details .sage-access-hint')].map((p: any) => p.textContent),
        [
          '“to take notes”',
          'Not available: Keychain Access (never granted).',
          'Browsers are view only; terminals and editors, click only.',
        ],
      );
      // a person unchecks Terminal: only Notes is allowed, with the extras the request asked for
      const boxes = m.host.querySelectorAll('input[type="checkbox"]') as any;
      await personClick(boxes[1]);
      await personClick(m.button('Allow in this chat ⏎'));
      assert.deepEqual(answers(), [
        ['sa-1', { decision: 'allow', apps: ['com.apple.Notes'], clipboardRead: true, clipboardWrite: true, systemKeyCombos: true }],
      ]);
      // and checks it again
      await personClick(boxes[1]);
      await press('1');
      assert.deepEqual(answers()[1][1].apps, ['com.apple.Notes', 'com.apple.Terminal']);
    } finally {
      await m.close();
    }
  });

  test('a desktop access card with every app unchecked cannot be allowed, by click or key', async () => {
    const m = await sageCard({ kind: 'computerAccessSet', apps: [deskApps[0]] });
    try {
      assert.equal(m.host.querySelector('.approval-message')?.textContent, 'Allow Codex to use Notes?');
      await personClick(m.host.querySelector('input[type="checkbox"]'));
      assert.equal(m.button('Allow in this chat ⏎').disabled, true);
      await press('Enter');
      await press('1');
      assert.deepEqual(answers(), []);
      await press('Escape');
      assert.deepEqual(answers(), [['sa-1', { decision: 'deny' }]]);
    } finally {
      await m.close();
    }
  });

  test('desktop access keys: Enter allows, but not from a text field, an open menu, another card, or a script', async () => {
    const m = await sageCard({ kind: 'computerAccessSet', clipboardRead: true });
    try {
      assert.equal(m.host.querySelector('.approval-message')?.textContent, 'Allow Codex to read the clipboard?');
      assert.equal(m.host.querySelector('.desktop-access-apps') === null, true);
      const input = document.createElement('input');
      document.body.append(input);
      await press('Enter', input);
      input.remove();
      const layer = document.createElement('div');
      layer.className = 'popover-layer';
      document.body.append(layer);
      await press('Enter');
      layer.remove();
      const other = document.createElement('div');
      other.className = 'approval-card';
      const inside = document.createElement('span');
      other.append(inside);
      document.body.append(other);
      await press('Enter', inside);
      other.remove();
      // a key a script dispatched (browsers mark it untrusted; happy-dom leaves isTrusted unset, so it is set here)
      await act(async () => {
        const e = new window.KeyboardEvent('keydown', { key: 'Enter' }) as any;
        Object.defineProperty(e, 'isTrusted', { value: false });
        window.dispatchEvent(e);
      });
      await press('x');
      // a script's click does nothing either
      await act(async () => {
        m.button('Allow in this chat ⏎').click();
      });
      assert.deepEqual(answers(), []);
      await press('Enter');
      assert.deepEqual(answers(), [
        ['sa-1', { decision: 'allow', apps: [], clipboardRead: true, clipboardWrite: undefined, systemKeyCombos: undefined }],
      ]);
      await personClick(m.button('Deny Esc'));
      assert.deepEqual(answers()[1], ['sa-1', { decision: 'deny' }]);
    } finally {
      await m.close();
    }
    // unmounted: the card no longer listens
    f.calls = [];
    await press('Enter');
    assert.deepEqual(answers(), []);
  });

  test('a takeover card asks to control the screen for this chat', async () => {
    const m = await sageCard({ kind: 'computerTakeover' });
    try {
      assert.match(m.host.querySelector('.approval-message')!.textContent!, /^Allow Codex to use your mouse and keyboard\?$/);
      assert.equal(m.host.querySelector('.desktop-access-details') === null, true);
      await personClick(m.button('Allow ⏎'));
      assert.deepEqual(answers(), [['sa-1', { decision: 'allow' }]]);
    } finally {
      await m.close();
    }
  });
}
