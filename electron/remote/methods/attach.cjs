// The remote methods that carry bytes with a message: attach a file and transcribe a recording, whole (the panel) or in parts (a phone's sealed frames hold 256 KB).
const { uploadOwner: ownerOf, rememberAttachment } = require('../attachmentOwners.cjs');
const { streamsOf, transcribeUpload } = require('../chunks.cjs');

module.exports = {
  'chat.attach': async (svc, client, p) => {
    if (!p.stream) return rememberAttachment(svc, client, await svc.ops.attach(p));
    const got = streamsOf(svc).add(ownerOf(client), p);
    if (!got.done || p.purpose === 'audio')
      return { stream: p.stream, received: got.received, done: got.done, ...(got.bytes ? { bytes: got.bytes } : {}) };
    // the whole file lands where the panel's attachments do, named by an id
    const dataUrl = `data:${p.mime || 'application/octet-stream'};base64,${got.whole.toString('base64')}`;
    return {
      ...rememberAttachment(svc, client, await svc.ops.attach({ dataUrl, name: p.name })),
      stream: p.stream,
      received: got.received,
      done: true,
    };
  },
  'chat.transcribe': (svc, client, p) => {
    if (!p.stream) return svc.ops.dictation.transcribe(p);
    return transcribeUpload(svc, client, p);
  },
};
