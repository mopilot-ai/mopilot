// Native app approvals and generic form/URL elicitation.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { act, nativeRequest, approvals, resolved, footer, window } from './fixture';

export function registerElicitationCases() {
  /* ------------------------------ Approvals ------------------------------ */

  test("Codex native app approval shows the app and Codex App's grants, led by Allow this conversation", async () => {
    const m = await approvals(nativeRequest());
    try {
      assert.equal(m.host.querySelector('.approval-title')?.textContent, 'Allow Codex to use Safari?');
      assert.equal(m.host.querySelector('.approval-head .approval-subtitle')?.textContent, 'computer-use-server');
      assert.equal(m.host.querySelector('.approval-body')?.textContent, 'Safari');
      assert.equal(m.host.querySelector('[role="alert"]') === null, true);
      assert.equal(m.host.querySelector('.form-field') === null, true);
      assert.deepEqual(footer(m.host), [
        { text: 'Decline', cls: 'btn ghost sm' },
        { text: 'Always allow', cls: 'btn ghost sm' },
        { text: 'Allow this conversation', cls: 'btn primary sm' },
      ]);
      assert.equal(document.activeElement === m.button('Allow this conversation'), true);
    } finally {
      await m.close();
    }
  });

  for (const [label, expected] of [
    ['Allow this conversation', { action: 'accept', content: {}, _meta: { persist: 'session' } }],
    ['Always allow', { action: 'accept', content: {}, _meta: { persist: 'always' } }],
    ['Decline', { action: 'decline', content: null, _meta: null }],
  ] as const) {
    test(`native app approval "${label}" answers with its grant`, async () => {
      const m = await approvals(nativeRequest());
      try {
        await m.click(m.button(label));
        assert.deepEqual(resolved(), [['req-1', expected]]);
      } finally {
        await m.close();
      }
    });
  }

  test('native app approval shows only the grants offered, its message, connector, targets and warning', async () => {
    const m = await approvals(
      nativeRequest(
        { message: 'Codex wants to use Notes' },
        {
          persist: undefined,
          connector_name: 'Computer Use',
          warningSubtitle: 'Codex can see everything in this app',
          tool_params_display: [{ display_name: 'App', value: 'Notes' }, { name: 'Window', value: 2 }, {}, null],
        },
      ),
    );
    try {
      assert.equal(m.host.querySelector('.approval-title')?.textContent, 'Codex wants to use Notes');
      assert.equal(m.host.querySelector('.approval-head .approval-subtitle')?.textContent, 'Computer Use');
      // entries with no label or value carry nothing to show
      assert.deepEqual(
        [...m.host.querySelectorAll('.approval-body > div:not([role])')].map((d: any) => d.textContent),
        ['App: Notes', 'Window: 2'],
      );
      assert.equal(m.host.querySelector('[role="alert"]')?.textContent, 'Codex can see everything in this app');
      assert.deepEqual(
        footer(m.host).map((b) => b.text),
        ['Decline', 'Allow this conversation'],
      );
      // no session grant offered: a plain accept, as Codex App answers it
      await m.click(m.button('Allow this conversation'));
      assert.deepEqual(resolved(), [['req-1', { action: 'accept', content: {}, _meta: null }]]);
    } finally {
      await m.close();
    }
  });

  test("a Sky app approval shows its own message, risk level and warning subtitle as sent, and names a grant it can't give", async () => {
    const m = await approvals(
      nativeRequest(
        { message: 'Allow Computer Use to use "Notes"?' },
        {
          connector_name: 'Computer Use',
          riskLevel: 'high',
          subtitle: 'Notes can contain private information.',
          persist: ['session', 'always', 'turn'],
          tool_name: 'get_app_state',
          tool_params_display: [{ name: 'app', display_name: 'App', value: 'Notes' }],
        },
      ),
    );
    try {
      assert.equal(m.host.querySelector('.approval-title')?.textContent, 'Allow Computer Use to use "Notes"?');
      assert.equal(m.host.querySelector('.approval-card')?.getAttribute('data-risk'), 'high');
      const risk = m.host.querySelector('.approval-risk[role="note"]');
      assert.equal(risk?.getAttribute('data-level'), 'high');
      assert.equal(risk?.textContent?.trim(), 'High risk');
      assert.equal(m.host.querySelector('[role="alert"]')?.textContent, 'Notes can contain private information.');
      assert.equal(m.host.querySelector('[data-unsupported]')?.textContent, "Can't grant here: turn.");
      // elevated risk keeps Codex App's primary: Allow this conversation
      assert.deepEqual(footer(m.host), [
        { text: 'Decline', cls: 'btn ghost sm' },
        { text: 'Always allow', cls: 'btn ghost sm' },
        { text: 'Allow this conversation', cls: 'btn primary sm' },
      ]);
    } finally {
      await m.close();
    }
    // another level is shown as sent; a request about no app names its tool
    const audio = await approvals(
      nativeRequest({}, { riskLevel: 'elevated', tool_name: 'start_audio_recording', tool_params: {}, persist: ['session'] }),
    );
    try {
      assert.equal(audio.host.querySelector('.approval-title')?.textContent, 'Allow Codex to record computer audio?');
      assert.equal(audio.host.querySelector('.approval-risk strong')?.textContent, 'Risk: elevated');
      assert.equal(audio.host.querySelector('.approval-body > div:not([role])')?.textContent, 'start_audio_recording');
      assert.equal(audio.host.querySelector('[data-unsupported]'), null);
      await audio.click(audio.button('Allow for this session'));
      assert.deepEqual(resolved(), [['req-1', { action: 'accept', content: {}, _meta: { persist: 'session' } }]]);
    } finally {
      await audio.close();
    }
  });

  test('native app approval omits an empty or non-text warning', async () => {
    for (const warningSubtitle of ['', 42]) {
      const m = await approvals(nativeRequest({}, { warningSubtitle, tool_params_display: 'not a list' }));
      try {
        assert.equal(m.host.querySelector('[role="alert"]') === null, true, String(warningSubtitle));
        assert.equal(m.host.querySelector('.approval-body')?.textContent, 'Safari');
      } finally {
        await m.close();
      }
    }
  });

  test('an ordinary MCP form elicitation keeps the form and sends its values on Submit', async () => {
    const m = await approvals({
      id: 'req-2',
      method: 'mcpServer/elicitation/request',
      threadId: 'chat',
      params: {
        serverName: 'docs',
        mode: 'form',
        message: 'Pick a name',
        requestedSchema: { type: 'object', properties: { name: { type: 'string', title: 'Name' } } },
      },
    });
    try {
      assert.equal(m.host.querySelector('.approval-title')?.textContent, 'docs needs input');
      const field = m.host.querySelector('.form-field input') as any;
      await act(() => {
        Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!.call(field, 'Ada');
        field.dispatchEvent(new window.Event('input', { bubbles: true }));
      });
      await m.click(m.button('Submit'));
      assert.deepEqual(resolved(), [['req-2', { action: 'accept', content: { name: 'Ada' }, _meta: null }]]);
    } finally {
      await m.close();
    }
  });

  test('a computer-use form that asks for fields is an ordinary elicitation, and Decline sends no content', async () => {
    const req = nativeRequest({ requestedSchema: { type: 'object', properties: { reason: { type: 'string' } } } });
    const m = await approvals(req);
    try {
      assert.ok(m.host.querySelector('.form-field'));
      assert.equal(m.button('Allow once'), undefined);
      await m.click(m.button('Decline'));
      assert.deepEqual(resolved(), [['req-1', { action: 'decline', content: null, _meta: null }]]);
    } finally {
      await m.close();
    }
  });

  test('a URL elicitation is finished with Done and sends no content', async () => {
    const m = await approvals({
      id: 'req-3',
      method: 'mcpServer/elicitation/request',
      threadId: 'chat',
      params: { serverName: 'auth', mode: 'url', url: 'https://example.com/login', message: 'Sign in' },
    });
    try {
      assert.equal(m.button('Submit'), undefined);
      await m.click(m.button('Done'));
      assert.deepEqual(resolved(), [['req-3', { action: 'accept', content: null, _meta: null }]]);
    } finally {
      await m.close();
    }
  });
}
