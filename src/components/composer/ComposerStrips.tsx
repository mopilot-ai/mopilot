// The strips a chat shows above its composer that are about the chat rather than the draft: a site's sign-in sheet, a handoff in progress, a blocked chat, messages allowed for an errand, its machine being offline, and the agent's sign-in on the machine the chat runs on.
import { BlockedStrip } from '../thread/BlockedStrip';
import { BrowserCredentialSheet } from '../thread/BrowserCredentialSheet';
import { HandoffStrip } from '../thread/HandoffStrip';
import { HostLineStrip } from './HostAttentionStrip';
import { GitSignInNote } from './GitSignInNote';
import { HostSigninCard } from './HostSigninCard';
import { ErrandStrip } from './ErrandStrip';

/** @param agent the chat's agent (a first-tier harness or a basic agent's id), for the machine sign-in card; the new chat (no `threadId`) shows only that card */
export function ComposerStrips({ threadId, agent }: { threadId: string | null; agent: string | null }) {
  return (
    <>
      {threadId && <BrowserCredentialSheet threadId={threadId} />}
      {threadId && <HandoffStrip threadId={threadId} />}
      {threadId && <BlockedStrip threadId={threadId} />}
      {threadId && <ErrandStrip threadId={threadId} />}
      {threadId && <HostLineStrip threadId={threadId} />}
      {threadId && <GitSignInNote threadId={threadId} />}
      <HostSigninCard threadId={threadId} agent={agent} />
    </>
  );
}
