// Prepares chat references only for the current composer input and route, rejecting unsupported Cloud chips first.

import { useRef, useState, type RefObject } from 'react';
import { chatReferences } from '../../session/chatReference';
import { sessionMentions } from '../../lib/sessionMentions';
import { errorText } from '../../lib/ignored';
import { get as getState, useStore, toast } from '../../store/core';
import { chatBasicHarness, newChatBasic } from '../../store/chats';
import { newChatHostPick } from '../../store/projects';
import { composerFirstTier } from '../../session/harness/select';
import { harnessKindFrom, pendingBasic } from '../../harness/family';
import type { HarnessKind } from '../../harness/adapter';
import { sessionOf } from '../../store/session/useSession';
import type { Attachment } from '../../store/types';
import type { ComposerInputElement } from './ComposerInput';
import { native } from '../../lib/native';
import { cloudSidebarAccount } from '../../lib/cloudSidebarAccount';
import { repositoryDraftProblem } from '../../store/repositoryDraft';

interface Input {
  threadId: string | null;
  text: string;
  attachments: Attachment[];
  goalMode: boolean;
  planMode: boolean;
  /** null while the chat's harness hasn't resolved */
  kind: HarnessKind | null;
  cloudCap: boolean;
}

/** Each input/route owns its pending read. A new input can prepare while the retired read finishes. */
export function useComposerReferences(input: Input, editor: RefObject<ComposerInputElement | null>) {
  const canCloud = !input.threadId && !input.goalMode && input.cloudCap;
  const environment = useStore((s) => (canCloud ? s.newChatCloudEnv?.id : null));
  const route = useStore((s) => (input.threadId ? null : s.route));
  const hostId = useStore((s) => (!input.threadId ? newChatHostPick(s)?.id : undefined));
  const folder = useStore((s) => (!input.threadId ? newChatHostPick(s)?.path : undefined));
  const repository = useStore((s) => (input.threadId ? undefined : s.newChatRepositoryGroup));
  const cloudOwner = useStore((s) => (repository && canCloud ? cloudSidebarAccount(s) : undefined));
  const identity = [
    input.threadId,
    input.text,
    input.attachments,
    input.goalMode,
    input.planMode,
    input.kind,
    canCloud,
    environment,
    route,
    hostId,
    folder,
    repository,
    cloudOwner,
  ];
  const owner = useRef(identity);
  if (owner.current.some((value, index) => value !== identity[index])) owner.current = identity;
  const pending = useRef<unknown[] | null>(null);
  // how many sends have prepared: a send is the latest while no other one has started since
  const started = useRef(0);
  const [preparing, setPreparing] = useState<unknown[] | null>(null);

  const prepareReferences = async () => {
    const { threadId, text, attachments, kind } = input;
    const current = owner.current;
    if (pending.current === current) return null;
    const state = getState();
    const cloudEnv = canCloud ? state.newChatCloudEnv : null;
    const problem = threadId ? null : repositoryDraftProblem(state, cloudEnv);
    if (problem) {
      toast(problem, 'error');
      return null;
    }
    if (cloudEnv) {
      const mentioned = new Set(sessionMentions(text).map((mention) => mention.id));
      if (attachments.some((attachment) => attachment.kind !== 'session' || !mentioned.has(attachment.path))) {
        toast('Cloud tasks do not support these attachments. Please remove them or choose local execution.', 'error');
        return null;
      }
    }
    const isCurrent = () => {
      const state = getState();
      const basic = pendingBasic(
        sessionOf(threadId).pendingSwitch?.harness,
        threadId ? chatBasicHarness(threadId, state) : newChatBasic(state),
      );
      const currentKind = harnessKindFrom(composerFirstTier(threadId, state), basic);
      const host = threadId ? null : newChatHostPick(state);
      return (
        owner.current === current &&
        editor.current?.value === text &&
        (!canCloud || state.newChatCloudEnv?.id === environment) &&
        (!!threadId || state.route === route) &&
        host?.id === hostId &&
        host?.path === folder &&
        currentKind === kind &&
        (!!threadId || state.newChatRepositoryGroup === repository) &&
        (cloudOwner === undefined || cloudOwner === cloudSidebarAccount(state))
      );
    };
    pending.current = current;
    const mine = ++started.current;
    setPreparing(current);
    let refs: Attachment[] | null = null;
    try {
      refs = await chatReferences(text, threadId ?? null);
    } catch (error) {
      if (isCurrent()) toast(`Couldn't reference the chat: ${errorText(error)}`, 'error');
    } finally {
      if (pending.current === current) {
        pending.current = null;
        setPreparing(null);
      }
    }
    const launchCloud = (id: string, prompt: string) =>
      repository
        ? native.cloud.exec(id, prompt, 1, { repository: repository.repository, account: state.accounts.active })
        : native.cloud.exec(id, prompt);
    return refs ? { refs, cloudEnv, isCurrent, isLatest: () => started.current === mine, launchCloud } : null;
  };

  return { preparingReferences: preparing === owner.current, prepareReferences };
}
