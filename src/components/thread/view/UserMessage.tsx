// Sent-message bubbles, mentions/links, images and edit recovery.
import { sessionMentions } from '../../../lib/sessionMentions';
import { tabMentions } from '../../../../shared/tabMentions.mjs';
import { useContext } from 'react';
import { useStore, toast } from '../../../store/core';
import { navigate } from '../../../store/panes';
import { editBlockedFor } from '../../../store/actions';
import { giveBackToComposer } from '../../../store/send';
import { SkillLink } from '../../markdown/SkillLink';
import { openSkillClick } from '../../../session/openSkill';
import { SkillGlyph } from '../../markdown/SkillGlyph';
import { useSentSkill } from './sentSkill';
import { refusalText, runSemantic } from '../../../store/session/runSemantic';
import type { ThreadItem } from '../../../store/types';
import { MessageImages } from './MessageImages';
import { AudioMessage } from '../../composer/AudioMessage';
import { QuestionReplyBubble } from '../QuestionReplyBubble';
import { SelectionChip } from '../../composer/SelectionChip';
import { parseDelegation, parseUserText } from '../../../lib/format';
import { FoldedText } from '../../ui/FoldedText';
import { Mic } from '../../ui/icons';
import { Tooltip } from '../../ui/Popover';
import { Copy, Check, Pencil, Globe } from '../../ui/icons';
import { useCopyConfirm } from '../../../session/copyConfirm';
import { errorText } from '../../../lib/ignored';
import { navigationId } from '../../../session/threadNavigation';
import { openMessageLink } from '../../../session/open';
import { PeerContext } from '../PeerMessages';
import { ReceivedMessage } from '../ReceivedMessage';
import { peerForItem } from '../../../lib/peerItem';
import { sideSessionEntryForItem, useOrchestration } from '../../../lib/sideSessions';
import { SideSessionCard } from '../SideSessionCard';
import { AuthoredInputCard } from '../AuthoredInputCard';
import { authoredFor, markedInputFor } from '../../../lib/authoredInput';
import { withKeys } from '../../../lib/listKeys';
import { linesLabel } from '../../diff/DiffComments';
import { selectionAttachment } from '../../../lib/annotations';
import { splitLinks } from '../../../../shared/proseLinks.mjs';
import { splitQuote } from '../../../../shared/quotedReply.mjs';
import { fileMentions } from '../../../lib/fileMentions';
import { FileMentionLink } from '../../markdown/MessagePathLink';
import { RemoteFolderContext, remoteCwd } from '../../../lib/remoteFolder';
import { useFolderHere } from '../../../lib/chatMachine';

export type UserMessageItem = Extract<ThreadItem, { type: 'userMessage' }>;

/** The copy button's key: this message is the only thing it copies, and its text may be empty. */
const MESSAGE = 'message';

export function UserMessage({
  item,
  threadId,
  turnId,
  userIndex,
  canEdit,
}: {
  item: UserMessageItem;
  threadId: string;
  turnId: string;
  userIndex: number;
  canEdit: boolean;
}) {
  const peer = peerForItem(useContext(PeerContext), threadId, item);
  // `@path` mentions open in this chat's folder ('' while not known yet: nothing is looked up); a chat on a machine
  // names files there, never looked up on this Mac
  const remote = useContext(RemoteFolderContext);
  const localCwd = useFolderHere(
    threadId,
    useStore((st) => st.threads[threadId]?.cwd ?? ''),
  );
  const cwd = remote ? remoteCwd(remote.machineId, remote.folder) : localCwd;
  const parsed = parseUserText(
    item.content
      .filter((c) => c.type === 'text')
      .map((c) => c.text)
      .join('\n'),
  );
  const text = peer?.body ?? parsed.text;
  const images: { type: string; url?: string; path?: string }[] = item.content.filter((c) => c.type === 'localImage' || c.type === 'image');
  const mentions = item.content.filter((c) => c.type === 'mention' || c.type === 'skill');
  const files = parsed.files.filter((f) => !images.some((im) => im.path === f.path));
  const delegation = parseDelegation(text);
  // a skill the message starts ("/fix-bug tidy up") reads as the skill and what it was asked, as Claude Code shows it
  const skill = useSentSkill(threadId, text);
  const { copied, copy } = useCopyConfirm();
  // Claude chats rewind to a file checkpoint; messages from before checkpoints can't (D-68)
  const blocked = useStore((st) => editBlockedFor(st, threadId, turnId));
  // a brief, wake-up or family message main delivered is shown as that, never as the user's words
  const side = sideSessionEntryForItem(useOrchestration(), item);
  // and an input main sent that no human wrote (MoMo's routine result) as its author's: never its text, nor as the user's
  const recorded = useStore((st) => authoredFor(st.authoredInputs, threadId, item));
  const authored = recorded ?? markedInputFor(item);
  if (side) return <SideSessionCard delivery={side.delivery} itemKey={side.key} />;
  if (authored) return <AuthoredInputCard input={authored} />;
  // a message from another chat reads as a linked session's does (Claude Desktop's "Received message from"), never as the user's
  if (peer)
    return (
      <div className="side-session-card side-session-wake" data-kind="message">
        <ReceivedMessage from={peer.sourceChatId} name={peer.sourceTitle} body={peer.body} openKey={`peer:${peer.id}`} />
      </div>
    );
  return (
    <div className="user-message" data-selection-source={item.id} data-navigation-id={navigationId(turnId, item.id, userIndex)}>
      {item.content
        .filter((c) => c.type === 'localAudio')
        .map((c) => (
          <AudioMessage key={c.path} path={c.path} />
        ))}
      <MessageImages chatId={threadId} images={images.map((im) => ({ src: im.url, path: im.path }))} />
      {mentions.length > 0 && (
        <div className="user-mentions">
          {withKeys(mentions, (m) => JSON.stringify([m.type, m.name, m.path])).map(({ key, item: m }) =>
            m.type === 'skill' ? (
              <SkillLink key={key} path={m.path}>
                {m.name}
              </SkillLink>
            ) : (
              <span key={key} className="mention-chip" title={m.path}>
                @{m.name}
              </span>
            ),
          )}
        </div>
      )}
      {parsed.selections.length > 0 && (
        <div className="user-selections">
          <SelectionChip selections={parsed.selections} align="end" />
        </div>
      )}
      {files.length > 0 && (
        <div className="user-mentions">
          {withKeys(files, (f) => f.path).map(({ key, item: f }) => (
            // a real link, so Tab reaches it and Enter opens the file like a click
            <a
              key={key}
              className="mention-chip file"
              href={f.path}
              title={f.path}
              onClick={(e) => {
                e.preventDefault();
                openMessageLink(f.path, undefined, e);
              }}
            >
              {f.name}
            </a>
          ))}
        </div>
      )}
      {parsed.chromeTab && <ChromeTabChip url={parsed.chromeTab} />}
      {parsed.annotations.some((_, i) => i !== parsed.questionReply?.annotationIndex) && (
        <div className="user-annotations">
          {withKeys(parsed.annotations, (a) => JSON.stringify([a.text, a.annotation, a.file])).map(({ key, item: a, index }) =>
            index === parsed.questionReply?.annotationIndex ? null : (
              <div key={key} className="user-annotation">
                {a.file && (
                  <div className="user-annotation-file">
                    {a.file.path} · {linesLabel(a.file.lines)}
                  </div>
                )}
                <div className={`user-annotation-quote${a.file ? ' code' : ''}`}>{a.text}</div>
                {a.annotation && <div className="user-annotation-comment">{a.annotation}</div>}
              </div>
            ),
          )}
        </div>
      )}
      {delegation?.flush ? (
        <div className="voice-ended">
          <Mic size={13} strokeWidth={1.8} /> Voice session ended
        </div>
      ) : delegation ? (
        <div className="user-bubble voice">
          <span className="voice-tag">
            <Mic size={12} strokeWidth={2} /> Voice
          </span>
          <FoldedText text={delegation.input} />
        </div>
      ) : parsed.questionReply ? (
        <QuestionReplyBubble question={parsed.questionReply.question}>
          <FoldedText text={text}>{linkify(text, cwd)}</FoldedText>
        </QuestionReplyBubble>
      ) : (
        text && (
          <div className="user-bubble">
            <FoldedText text={text}>
              {skill ? (
                <>
                  {skill.file ? (
                    <a
                      className="bubble-skill open"
                      href={skill.file.path}
                      title={skill.file.description || `Skill /${skill.name}`}
                      onClick={(e) => {
                        e.preventDefault();
                        openSkillClick(skill.file!.path, e);
                      }}
                    >
                      <SkillGlyph size={14} />
                      <span>/{skill.name}</span>
                    </a>
                  ) : (
                    <span className="bubble-skill" title={`Skill /${skill.name}`}>
                      <SkillGlyph size={14} />
                      <span>/{skill.name}</span>
                    </span>
                  )}
                  {linkify(skill.rest, cwd)}
                </>
              ) : (
                quoted(text, cwd)
              )}
            </FoldedText>
          </div>
        )
      )}
      <div className="user-actions">
        {/* keyed, not tested for truth: an image-only message has no text, and copying it still confirms */}
        <Tooltip label={copied === MESSAGE ? 'Copied' : 'Copy'}>
          <button className="icon-btn xs" onClick={() => copy(text, MESSAGE)}>
            {copied === MESSAGE ? <Check size={14} className="copy-check" /> : <Copy size={14} />}
          </button>
        </Tooltip>
        {canEdit && !turnId.startsWith('pending-') && (
          <Tooltip label={blocked ?? 'Edit message'}>
            <button
              className="icon-btn xs"
              aria-label="Edit message"
              disabled={!!blocked}
              onClick={() => editMessage(threadId, turnId, text, parsed.selections)}
            >
              <Pencil size={14} />
            </button>
          </Tooltip>
        )}
      </div>
    </div>
  );
}

/** A phone's Reply on a selection sends the quote ("> " lines, a blank line) ahead of its words: the quote is drawn as a quote block. */
function quoted(text: string, cwd?: string | null): React.ReactNode {
  const split = splitQuote(text);
  if (!split) return linkify(text, cwd);
  return (
    <>
      <blockquote className="user-quote">{linkify(split.quote, cwd)}</blockquote>
      {linkify(split.rest, cwd)}
    </>
  );
}

/**
 * URLs in user bubbles render bold with a globe glyph, like the official app; chat and browser tab references as chips;
 * `@path` file mentions as links once a file is there, resolved in the chat's folder (`cwd`; none: they stay text).
 */
export function linkify(text: string, cwd?: string | null): React.ReactNode[] {
  const chats = [...sessionMentions(text), ...tabMentions(text)].sort((a, b) => a.start - b.start);
  if (chats.length) {
    const out: React.ReactNode[] = [];
    let last = 0;
    for (const m of chats) {
      out.push(<span key={`before:${m.start}`}>{linkify(text.slice(last, m.start), cwd)}</span>);
      out.push(
        'id' in m ? (
          <a
            key={`session:${m.start}`}
            className="bubble-link composer-session-token"
            title={m.title}
            href={`#thread=${encodeURIComponent(m.id)}`}
            onClick={(e) => {
              e.preventDefault();
              navigate({ name: 'thread', id: m.id });
            }}
          >
            {m.title}
          </a>
        ) : (
          <span key={`tab:${m.start}`} className="bubble-link composer-session-token composer-tab-token" title={m.url}>
            {m.title}
          </span>
        ),
      );
      last = m.end;
    }
    out.push(<span key="tail">{linkify(text.slice(last), cwd)}</span>);
    return out;
  }
  // no folder known: a relative path would be looked up against nothing, so mentions stay text
  const files = cwd ? fileMentions(text) : [];
  if (files.length) {
    const out: React.ReactNode[] = [];
    let last = 0;
    for (const m of files) {
      out.push(<span key={`before:${m.start}`}>{linkUrls(text.slice(last, m.start))}</span>);
      out.push(<FileMentionLink key={`mention:${m.start}`} token={m.token} path={m.path} cwd={cwd} />);
      last = m.end;
    }
    out.push(<span key="tail">{linkUrls(text.slice(last))}</span>);
    return out;
  }
  return linkUrls(text);
}

/** Web addresses in a bubble's text, bold with a globe glyph. */
function linkUrls(text: string): React.ReactNode[] {
  // a link at each odd index, without the punctuation of the sentence it ends
  const parts = splitLinks(text);
  // a message's fixed text: each piece is told apart by its content and how often it came before
  return withKeys(parts, (p) => p).map(({ key, item: p }) =>
    /^https?:\/\//.test(p) ? (
      <a
        key={key}
        className="bubble-link"
        href={p}
        onClick={(e) => {
          e.preventDefault();
          openMessageLink(p, undefined, e);
        }}
      >
        <Globe size={13} strokeWidth={1.8} />
        {p}
      </a>
    ) : (
      p
    ),
  );
}

/** The Chrome tab a message was sent from in the side panel, by its site; the whole address on hover, opened on click. */
function ChromeTabChip({ url }: { url: string }) {
  // an address that doesn't parse (not one the panel writes) shows as it is
  const site = URL.canParse(url) ? new URL(url).host : url;
  return (
    <div className="user-mentions">
      <a
        className="mention-chip file tab"
        href={url}
        title={url}
        onClick={(e) => {
          e.preventDefault();
          openMessageLink(url, undefined, e);
        }}
      >
        <Globe size={12} strokeWidth={1.8} />
        {site}
      </a>
    </div>
  );
}

async function editMessage(threadId: string, turnId: string, text: string, selections: string[] = []) {
  try {
    // the harness rewinds the chat to before this message (Claude: files and conversation to its checkpoint)
    const r = await runSemantic(threadId, 'rewind', turnId);
    if (r.ok === false) return void toast(refusalText(r, 'rewind'), 'error');
    if (!r.value) return;
    giveBackToComposer(threadId, text, selections.map(selectionAttachment));
  } catch (e) {
    toast(`Couldn't edit: ${errorText(e)}`, 'error');
  }
}
