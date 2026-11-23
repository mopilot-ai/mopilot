// Native heartbeat replies keep their readable report across Markdown, previews and transcript exports.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseDirectives, stripDirectives } from '../shared/codexDirectives.mjs';
import { transcriptMarkdown } from '../shared/transcriptMarkdown.mjs';
import { turnFromServer } from '../shared/codexTurns.mjs';
import { turnPreview } from '../src/lib/turnWindow.ts';
import { navigationItems } from '../src/session/threadNavigation.ts';
import type { ThreadItem } from '../src/protocol/v2/ThreadItem.ts';
import { createRequire } from 'node:module';
import { buildTurns } from './support/claude-translate.ts';

const { buildAcpTurns } = createRequire(import.meta.url)('../electron/harness/items/acpTranslator.cjs');

const report = 'Promoted **2 changes**.\n\nCounts: 596/9748 → 596/9749.\n\n[Report](/tmp/reports/completion.json)';
const heartbeat = (message: string, decision = 'NOTIFY') =>
  `<heartbeat>\n<automation_id>daily-question-generation-and-local-promotion</automation_id>\n<decision>${decision}</decision>\n<message>${message}</message>\n</heartbeat>`;
const reply = (text: string): ThreadItem => ({
  id: 'reply',
  type: 'agentMessage',
  phase: 'final_answer',
  text,
  memoryCitation: null,
  delivery: null,
  questions: null,
});
const nativeTurn = (items: ThreadItem[]) =>
  turnFromServer({ id: 'run', status: 'completed', items, error: null, startedAt: 1, completedAt: 2, durationMs: 1000 });

test('the reported completed heartbeat shows its full Markdown report and links', () => {
  for (const message of [report, `\n${report}\n`]) {
    const raw = heartbeat(message);
    assert.deepEqual(parseDirectives(raw), { markdown: report, followups: [] });
    assert.equal(stripDirectives(raw), report);
    assert.equal(stripDirectives(raw, true), report);
  }
});

test('NOTIFY and DONT_NOTIFY retain their messages and any permitted prefix prose', () => {
  for (const decision of ['NOTIFY', 'DONT_NOTIFY']) {
    const text = `Update first.\n\n${heartbeat('Finished.', decision)}\n`;
    assert.equal(parseDirectives(text).markdown, 'Update first.\n\nFinished.');
    assert.equal(stripDirectives(text), parseDirectives(text).markdown);
  }
});

test('wrapped directives still become links and follow-up buttons', () => {
  const raw = heartbeat('See :codex-file-citation{path="/tmp/report.md"}\n:codex-followup[More]{prompt="Details"}');
  assert.equal(parseDirectives(raw).markdown, 'See [](<codex-directive:file-citation?path=%2Ftmp%2Freport.md>)');
  assert.equal(parseDirectives(raw).followups[0].attrs.prompt, 'Details');
  assert.equal(stripDirectives(raw), 'See [report.md](</tmp/report.md>)');
});

test('code examples, unrelated XML, unknown decisions and incomplete saved replies remain literal', () => {
  const raw = heartbeat(report);
  for (const text of [
    `\`${heartbeat('Example.').replaceAll('\n', ' ')}\``,
    `\`\`\`xml\n${raw}\n\`\`\``,
    raw
      .split('\n')
      .map((line) => `    ${line}`)
      .join('\n'),
    `> ~~~xml\n${raw
      .split('\n')
      .map((line) => `> ${line}`)
      .join('\n')}\n> ~~~`,
    '<message>ordinary XML</message>',
    heartbeat('Keep it.', 'UNKNOWN'),
    '<heartbeat><message>Missing metadata</message></heartbeat>',
    raw.replace('daily-question-generation-and-local-promotion', ' '),
    heartbeat('   '),
    `${raw}\nAfter.`,
    `${raw}\n${raw}`,
    `${heartbeat('```js\nconst x = 1;\n```')}\n\n${raw}`,
    `${heartbeat('Unknown.', 'UNKNOWN')}\n\n${raw}`,
    `<heartbeat><message>Missing metadata</message></heartbeat>\n\n${raw}`,
    raw.slice(0, -1),
  ]) {
    assert.equal(parseDirectives(text).markdown, text);
    assert.equal(stripDirectives(text), text);
  }
});

test('message code containing closing tags cannot truncate the report', () => {
  for (const message of [
    'Use `</message></heartbeat>` literally.\n\nDone.',
    '```xml\n</message></heartbeat>\n```\n\nDone.',
    '    code\n    stays indented',
    `Example:\n\n\`\`\`xml\n${heartbeat('literal example')}\n\`\`\`\n\nDone.`,
  ]) {
    assert.equal(parseDirectives(heartbeat(`\n${message}\n`)).markdown, message);
  }
});

test('ordinary streaming text and incomplete opening tags stay literal until a heartbeat is identified', () => {
  for (const source of [
    'x < 3',
    '<div>Text</div>',
    '<h1>Title</h1>',
    '<header>Title</header>',
    '<heartbeat-extra>Example</heartbeat-extra>',
  ]) {
    for (let i = 1; i <= source.length; i++) {
      const text = source.slice(0, i);
      assert.equal(parseDirectives(text, true).markdown, text);
      assert.equal(stripDirectives(text, false, { streaming: true }), text);
    }
  }
});

test('recognized live heartbeats stay hidden until the message settles; saved malformed text stays available', () => {
  const raw = heartbeat(report);
  for (let i = '<heartbeat>'.length; i < raw.length; i++) {
    assert.equal(parseDirectives(raw.slice(0, i), true).markdown, '', `prefix ${i}`);
  }
  assert.equal(parseDirectives(raw, true).markdown, '');
  assert.equal(parseDirectives(raw, false).markdown, report);
  assert.equal(parseDirectives(`Before.\n\n${raw.slice(0, -1)}`, true).markdown, 'Before.\n\n');
  assert.equal(parseDirectives('Use `<heart`', true).markdown, 'Use `<heart`');
  assert.equal(parseDirectives('<heading', true).markdown, '<heading');
  const example = `\`\`\`xml\n${raw}\n\`\`\``;
  assert.equal(parseDirectives(`${example}\n\n<heading`, true).markdown, `${example}\n\n<heading`);
  assert.equal(parseDirectives(`${example}\n\n${raw}`).markdown, `${example}\n\n${report}`);
  assert.equal(parseDirectives(heartbeat('Keep.', 'UNKNOWN'), true).markdown, heartbeat('Keep.', 'UNKNOWN'));
});

test('reports ending in fenced or indented code keep their Markdown without a separator before the envelope close', () => {
  for (const message of ['```js\nconst x = 1;\n```', '~~~text\nDone.\n~~~', '    indented code']) {
    assert.equal(parseDirectives(heartbeat(message)).markdown, message);
    assert.equal(parseDirectives(`Before.\n\n${heartbeat(message)}`).markdown, `Before.\n\n${message}`);
    assert.equal(parseDirectives(`Before.\n\n${heartbeat(message)}\n\nAfter.`).markdown, `Before.\n\n${heartbeat(message)}\n\nAfter.`);
  }
});

test('quoted closing tags never expose metadata at any point in a live report', () => {
  const message = 'Use `</message></heartbeat>` literally.\n\nDone.';
  const raw = heartbeat(message);
  for (let i = '<heartbeat>'.length; i <= raw.length; i++) assert.equal(parseDirectives(raw.slice(0, i), true).markdown, '', `prefix ${i}`);
  assert.equal(parseDirectives(raw).markdown, message);
});

test('native history exports readable reports without changing stored items', () => {
  const raw = heartbeat(report);
  const turn = nativeTurn([reply(raw)]);
  assert.equal(transcriptMarkdown('Scheduled run', [turn]), `# Scheduled run\n\n## Assistant\n\n${report}\n`);
  assert.equal(turn.items[0].type === 'agentMessage' && turn.items[0].text, raw);
});

test('windowed history and navigation previews agree with the readable report', () => {
  const turn = nativeTurn([
    { id: 'prompt', type: 'userMessage', clientId: null, content: [{ type: 'text', text: 'Scheduled run', text_elements: [] }] },
    reply(heartbeat('Finished two changes.')),
  ]);
  assert.equal(turnPreview(turn).reply, 'Finished two changes.');
  assert.equal(navigationItems([turn])[0].response, 'Finished two changes.');
});

test('user-authored envelopes stay literal in navigation and transcript exports', () => {
  const raw = heartbeat('Example supplied by the user.');
  const turn = nativeTurn([
    { id: 'prompt', type: 'userMessage', clientId: null, content: [{ type: 'text', text: raw, text_elements: [] }] },
  ]);
  assert.equal(navigationItems([turn])[0].prompt, raw);
  assert.equal(stripDirectives(raw, true, { reply: false }), raw);
  assert.match(transcriptMarkdown('Example', [turn]), /<heartbeat>/);
});

test('live previews and exports hold a pending envelope and recover malformed text after interruption', () => {
  const raw = heartbeat('Finished.').slice(0, -1);
  const turn = nativeTurn([
    { id: 'prompt', type: 'userMessage', clientId: null, content: [{ type: 'text', text: 'Run', text_elements: [] }] },
    reply(raw),
  ]);
  const running = { ...turn, status: 'inProgress' as const };
  assert.equal(turnPreview(running).reply, '');
  assert.equal(navigationItems([running])[0].response, 'Working…');
  assert.doesNotMatch(transcriptMarkdown('Running', [running]), /<heartbeat>/);
  // Summaries await the turn's final snapshot, even if the per-item renderer can already finish pacing this reply.
  const early = { ...running, items: [turn.items[0], reply(heartbeat('Finished.'))], itemTimes: { reply: { start: 0, end: 0 } } };
  assert.equal(turnPreview(early).reply, '');
  assert.equal(navigationItems([early])[0].response, 'Working…');
  assert.doesNotMatch(transcriptMarkdown('Running', [early]), /Finished\./);
  assert.equal(turnPreview({ ...early, status: 'completed' }).reply, 'Finished.');
  const stopped = { ...turn, status: 'interrupted' as const };
  assert.match(turnPreview(stopped).reply, /<heartbeat>/);
  assert.equal(navigationItems([stopped])[0].response, raw);
  assert.match(transcriptMarkdown('Stopped', [stopped]), /<heartbeat>/);
});

test('Claude and ACP history producers preserve the same readable heartbeat outcome', () => {
  const raw = heartbeat(report);
  const claude = buildTurns(
    [
      { type: 'user', uuid: 'u', message: { role: 'user', content: 'Scheduled run' } },
      { type: 'assistant', uuid: 'a', message: { id: 'm', content: [{ type: 'text', text: raw }] } },
    ],
    'claude:chat',
    '/repo',
  );
  const acp = buildAcpTurns(
    [
      {
        t: 'user',
        turnId: 'run',
        user: { id: 'u', clientId: null, content: [{ type: 'text', text: 'Scheduled run', text_elements: [] }] },
      },
      { t: 'update', turnId: 'run', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: raw } } },
      { t: 'end', turnId: 'run', stopReason: 'end_turn' },
    ],
    'acp:chat',
    '/repo',
  );
  for (const turns of [claude, acp]) {
    const item = turns[0].items.find((item: any) => item.type === 'agentMessage');
    assert.equal(item.text, raw);
    assert.equal(parseDirectives(item.text).markdown, report);
    assert.match(transcriptMarkdown('Task', turns), /Promoted \*\*2 changes\*\*/);
    assert.doesNotMatch(transcriptMarkdown('Task', turns), /<heartbeat>/);
  }
});
