// The MCP gateway's approval card (kind gatewayTool, #2999 C3) as the chat draws it (src/components/thread/Approvals.tsx): HostAskCard with the server, the tool and the call's arguments, Allow once on Enter, Always allow on 2 or a click, Deny on Esc; each answer is the choice main reads (electron/gateway/offer.cjs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createElement, f, Approvals, mount, press, personClick } from './support/native-control-ui/fixture';

const answers = () => f.calls.filter((c: any[]) => c[0] === 'answer').map((c: any[]) => c.slice(1));

async function sageCard(params: any) {
  f.requests = [];
  f.session = { approvals: [{ id: 'sa-1', method: 'sage/approval', params }] };
  f.state = { segments: {}, runtime: {} };
  f.calls = [];
  return mount(createElement(Approvals, { threadId: 'chat', cwd: '/project' }));
}

test('a gateway tool card (gatewayTool) is drawn like hostAsk: server, tool and arguments, Allow once and Always allow', async () => {
  const m = await sageCard({
    kind: 'gatewayTool',
    harness: 'claude',
    title: 'Run add_note on notes?',
    message: 'notes is an MCP server MoPilot runs for you.',
    details: ['Server: notes', 'Tool: add_note', 'Arguments: {"text":"hi"}'],
    choices: [
      { id: 'once', label: 'Allow once' },
      { id: 'always', label: 'Always allow in this project' },
    ],
    gateway: { server: 'notes', tool: 'add_note', arguments: '{"text":"hi"}' },
  });
  try {
    assert.equal(m.host.querySelector('.approval-card')!.getAttribute('data-kind'), 'gatewayTool');
    assert.equal(m.host.querySelector('.approval-kind span')?.textContent, 'Run add_note on notes?');
    assert.equal(m.host.querySelector('p.sage-access-hint[title="Tool: add_note"] > code')?.textContent, 'Tool: add_note');
    assert.deepEqual(
      [...m.host.querySelectorAll('.approval-foot button')].map((b: any) => b.textContent),
      ['Deny Esc', 'Allow once ⏎', 'Always allow in this project 2'],
    );
    await press('Enter');
    await personClick(m.button('Always allow in this project 2'));
    await press('Escape');
    assert.deepEqual(answers(), [
      ['sa-1', { decision: 'allow', choice: 'once' }],
      ['sa-1', { decision: 'allow', choice: 'always' }],
      ['sa-1', { decision: 'deny' }],
    ]);
  } finally {
    await m.close();
  }
});
