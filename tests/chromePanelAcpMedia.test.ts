// Actual ACP native builders retain Chrome MCP call identity and screenshot bytes for the shared panel preview path.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { buildAcpTurns } from '../electron/harness/items/acpTranslator.cjs';
const require = createRequire(import.meta.url);
const { readPeerTurns } = require('../electron/session/peerTranscript.cjs');
const { rowsOf } = require('../electron/capabilities/browser/chromePanelLive.cjs');
for (const kind of ['other', 'read', 'execute'])
  test(`ACP ${kind} Chrome MCP screenshot uses the same native preview contract`, async () => {
    const image = { type: 'image', mimeType: 'image/png', data: 'A'.repeat(6000) };
    const turns = buildAcpTurns(
      [
        { t: 'user', turnId: 't', user: { id: 'u', clientId: null, content: [{ type: 'text', text: 'Read my page' }] }, at: 1 },
        {
          t: 'update',
          turnId: 't',
          update: {
            sessionUpdate: 'tool_call',
            toolCallId: 'shot',
            title: 'mcp__mopilot_chrome__computer',
            kind,
            status: 'completed',
            rawInput: { action: 'screenshot' },
            content: [null, { type: 'terminal', terminalId: 'fixture' }, { type: 'content', content: image }],
          },
          at: 2,
        },
        { t: 'end', turnId: 't', stopReason: 'end_turn', error: null, at: 3 },
      ],
      'acp:goose:native',
      '/work',
    );
    const full = await readPeerTurns({ segments: [{ kind: 'acp:goose', nativeId: 'native' }] }, async () => ({ turns }));
    const row = rowsOf(full.turns).rows.at(-1);
    assert.equal(row.text, 'Took a screenshot');
    assert.equal(row.surface, 'chrome');
    assert.equal(row.thumbnail, `data:image/png;base64,${image.data}`);
    assert.match(row.id, /shot/);
  });
