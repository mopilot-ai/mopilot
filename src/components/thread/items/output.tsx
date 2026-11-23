// Command output, tool input/results, screenshots and vendor problem details.
import { openLink } from '../../../session/open';
import { useContext, useRef } from 'react';
import { useEffectOn } from '../../../lib/effects';
import { CodeBlock } from '../../markdown/Markdown';
import { copyText } from '../../../session/clipboard';
import { ZoomableImage } from '../../ui/ImageLightbox';
import { native } from '../../../lib/native';
import { connect } from '../../../store/connection';
import { navigate } from '../../../store/panes';
import { sendMessage } from '../../../store/send';
import { toastFailure } from '../../../store/core';
import { AgentChatContext } from '../../agents/AgentChatContext';
import { toolOutput } from '../../../lib/toolOutput';
import { shownToolName } from '../../../lib/ownToolLines';
import { controlSource, skyProblemText, type SkyProblem, type SkyProblemAction } from '../../../lib/agentNarration';
import { prefixUnits } from '../../../../shared/textPrefix.mjs';
import { fingerprint, withKeys } from '../../../lib/listKeys';
import type { ToolCallItem } from './stepModel';
import type { SkillCall } from '../../../session/skillToolCall';
export function ShellBox({
  cmd,
  output,
  exitCode,
  unknownExit,
  live,
}: {
  cmd: string;
  output?: string | null;
  exitCode?: number | null;
  unknownExit?: boolean;
  live?: boolean;
}) {
  const scroll = useRef<HTMLDivElement>(null);
  // a running command's box follows its newest line
  useEffectOn([live, output], () => {
    if (live && scroll.current) scroll.current.scrollTop = scroll.current.scrollHeight;
  });
  return (
    <div className="shell-box">
      <div className="shell-head">
        <span>Shell</span>
        <button className="shell-copy" onClick={() => copyText(cmd, 'Copied command')} title="Copy command">
          Copy
        </button>
      </div>
      <div className="shell-scroll" ref={scroll}>
        <div className="shell-cmd">
          <span className="shell-prompt">$</span>
          {cmd}
        </div>
        {output ? <pre className="shell-out">{trimOutput(output)}</pre> : null}
        {exitCode != null && exitCode !== 0 && <div className="shell-exit">Exit code {exitCode}</div>}
        {unknownExit && <div className="shell-exit">Exit code unknown</div>}
      </div>
    </div>
  );
}

function trimOutput(s: string) {
  const lines = s.replace(/\n$/, '').split('\n');
  if (lines.length > 400) return [...lines.slice(0, 200), `… ${lines.length - 400} lines hidden …`, ...lines.slice(-200)].join('\n');
  return lines.join('\n');
}

/**
 * What Codex's computer use (Sky) reported for a failed step: the vendor's own message as sent, then
 * MoPilot's title, hint and the steps that fix it (a Privacy & Security pane, Computer use settings,
 * Try again). A vendor tool's request to open its own desktop app reads in MoPilot's words.
 */
export function SkyProblemNote({ problem }: { problem: SkyProblem }) {
  // the chat the step ran in: "Try again" asks its agent to run the step again
  const chatId = useContext(AgentChatContext);
  // an action that fails says why (a link that doesn't open, a check that can't run) instead of doing nothing
  const run = (a: SkyProblemAction) => {
    if (a.kind === 'url') openLink(a.url);
    else if (a.kind === 'retry') native.availability.retry().catch(toastFailure("Couldn't check again"));
    else if (a.kind === 'send') sendMessage(chatId, a.text).catch(toastFailure("Couldn't send"));
    else if (a.kind === 'restartCodex')
      native.codex
        .restart()
        .then(() => connect())
        .catch(toastFailure("Couldn't restart Codex"));
    else navigate({ name: 'settings', section: a.section });
  };
  // "Try again" asks the chat's agent: none outside a chat
  const actions = problem.actions.filter((a) => a.kind !== 'send' || !!chatId);
  return (
    <div className="sky-problem" role="alert" data-kind={problem.kind} data-code={problem.code ?? undefined}>
      <div className="sky-problem-title">{problem.title}</div>
      <div className="sky-problem-message">{skyProblemText(problem)}</div>
      {problem.hint && <div className="sky-problem-hint">{problem.hint}</div>}
      {actions.length > 0 && (
        <div className="sky-problem-actions">
          {actions.map((a) => (
            <button
              key={a.label}
              className="btn-pill soft"
              title={a.kind === 'restartCodex' ? 'Codex turns running in other chats stop too' : undefined}
              onClick={() => run(a)}
            >
              {a.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/** `hoisted`: the row already shows the call's screenshots below it, so its details don't draw them again. */
export function ToolIO({ item, hoisted = false }: { item: ToolCallItem; hoisted?: boolean }) {
  // image blocks (a browser or desktop screenshot) show as pictures, not base64 JSON
  const { text: result, images } = toolOutput(item);
  // a native control program reads as the code it ran, not a JSON string of it
  const source = controlSource(item);
  return (
    <div className="shell-box">
      <div className="shell-head">
        <span>{shownToolName(item)}</span>
      </div>
      {!!images.length && !hoisted && (
        <div className="tool-previews" aria-label="Screenshots">
          {withKeys(images, fingerprint).map(({ key, item: src, index }) => (
            <ZoomableImage key={key} className="tool-screenshot" src={src} alt={`Tool screenshot ${index + 1}`} />
          ))}
        </div>
      )}
      <div className="shell-scroll tool">
        <CodeBlock
          code={source ? source.code : JSON.stringify(item.arguments ?? {}, null, 2)}
          lang={source ? source.lang : 'json'}
          showHeader={false}
        />
        {result && (
          <CodeBlock
            code={result.length > 20000 ? prefixUnits(result, 20000) + '\n…' : result}
            lang={/^\s*[\[{]/.test(result) ? 'json' : 'text'}
            showHeader={false}
          />
        )}
      </div>
    </div>
  );
}

/** A skill call's details: the arguments it was given and what it said back, as text rather than the tool's JSON. */
export function SkillCallBody({ call }: { call: SkillCall }) {
  const output = call.output.length > 20000 ? prefixUnits(call.output, 20000) + '\n…' : call.output;
  return (
    <div className="shell-box">
      <div className="shell-head">
        <span>Skill · /{call.name}</span>
      </div>
      <div className="shell-scroll tool">
        {call.args && <CodeBlock code={call.args} lang="text" showHeader={false} />}
        {output && <CodeBlock code={output} lang="text" showHeader={false} />}
      </div>
    </div>
  );
}
