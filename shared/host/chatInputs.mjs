// Host chat-start/send inputs: text or negotiated image references, with the original effect identity, folder, picks and exact human flag.
import { chatOf, optionOf, pickOf, projectOf } from '../remote/schema.mjs';
import { IMAGE_FEATURE, imageRefs } from './images.mjs';
import { FILE_FEATURE, FILE_MIME, fileRefs } from './files.mjs';
import { credentialOf } from './logins.mjs';
import { SIDE_CHAT_FEATURE, sideChatUuid } from './sideChats.mjs';
import { GOAL_FEATURE } from './chatGoal.mjs';
import { nativeNeeds } from './nativeChats.mjs';

/** Features required by an input. Refuse older peers that would silently drop part of it. */
export function chatInputNeeds(method, params) {
  const message = method === 'chat.send' || method === 'chat.start';
  return [
    ...(message && params?.images?.length ? [IMAGE_FEATURE] : []),
    ...((message && params?.files?.length) || (method === 'chat.attach' && params?.mime === FILE_MIME) ? [FILE_FEATURE] : []),
    ...(method === 'chat.start' && params?.sideChat != null ? [SIDE_CHAT_FEATURE, 'journalLifecycle'] : []),
    ...(message && params?.goal === true ? [GOAL_FEATURE] : []),
    // a list or watch of native sessions (#5576) needs the peer's own features, or an older Host would answer with its chats only
    ...nativeNeeds(method, params),
  ];
}

export function chatInputParsers({ effect, pathOf, harnessOf, epochOf, bad }) {
  const input = (p) => {
    if (p.attachments?.length || p.skills?.length)
      throw bad('Files other than images and local skills cannot be sent to this machine yet.');
    const images = imageRefs(p.images, bad);
    const files = fileRefs(p.files, bad);
    const text = typeof p.text === 'string' ? p.text.trim() : '';
    if (!text && !images.images?.length && !files.files?.length) throw bad('Type a message first.');
    if (text.length > 100_000) throw bad('The message is too long.');
    return {
      ...effect(p),
      text,
      ...images,
      ...files,
      ...(p.cwd == null ? {} : { cwd: pathOf(p.cwd, 'a folder') }),
      ...(p.human === true ? { human: true } : {}),
      // the message is the chat's goal: its text is the objective (a Host without `goalControls` is never sent one, requireFeatures)
      ...(p.goal === true ? { goal: true } : {}),
      ...pickOf(p),
    };
  };
  const sideChatOf = (p) => {
    if (!sideChatUuid(p.chatId) && p.sideChat == null) return {};
    const side = p.sideChat;
    if (!sideChatUuid(p.chatId) || !side || side.sourceId === p.chatId) throw bad('That side chat has no valid parent.');
    return { sideChat: { sourceId: chatOf({ chatId: side.sourceId }), epoch: epochOf(side) } };
  };
  return {
    'chat.start': (p) => ({
      ...input(p),
      harness: harnessOf(p.harness),
      projectId: projectOf(p),
      ...(p.permission == null ? {} : { permission: optionOf(p.permission) }),
      // with Plan, the mode the person had picked: Plan runs its tools under it (a Host that does not take Plan is never sent one)
      ...(p.planBase == null ? {} : { planBase: optionOf(p.planBase) }),
      // where the model access comes from; left out is the Host's own order. An older Host would drop it, so a Host without `logins` is never sent one (requireFeatures)
      ...(p.credential == null ? {} : { credential: credentialOf(p.credential, bad) }),
      ...sideChatOf(p),
    }),
    // The folder matters when the Host has no native session yet, including after a restart.
    // `followUp: 'steer'`: the message goes into the turn that is running, where the agent can take it (an older Host drops the word, and the message waits behind the turn)
    'chat.send': (p) => ({ ...input(p), ...(p.followUp === 'steer' ? { followUp: 'steer' } : {}) }),
  };
}
