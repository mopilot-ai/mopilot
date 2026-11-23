// window.native.speech: current-chat voice options, capture ownership and durable audio messages.
const { ownedInvoke, on } = require('./spec.cjs');
const invoke = (channel, count) => ownedInvoke(channel, count, 'speech:document');
module.exports = {
  hold: invoke('speech:hold', 4),
  finishTransfer: invoke('speech:finishTransfer', 2),
  drafts: invoke('speech:drafts', 0),
  draft: invoke('speech:draft', 2),
  options: invoke('speech:options', 2),
  available: invoke('speech:available', 2),
  begin: invoke('speech:begin', 2),
  conversation: invoke('speech:conversation', 2),
  current: invoke('speech:current', 1),
  end: invoke('speech:end', 1),
  save: invoke('speech:save', 2),
  read: invoke('speech:read', 1),
  transcribe: invoke('speech:transcribe', 6),
  streamStart: invoke('speech:streamStart', 3),
  streamAudio: invoke('speech:streamAudio', 2),
  streamFinish: invoke('speech:streamFinish', 1),
  streamCancel: invoke('speech:streamCancel', 1),
  onStream: on('speech:stream'),
};
