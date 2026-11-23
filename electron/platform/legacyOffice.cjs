// Legacy Word and PowerPoint provide explicitly labelled text previews without an external Office installation.
// cfb and word-extractor load with the first legacy document read, not with main's startup (docs/architecture/rust-core.md §2)

/** Read only text atoms from the PowerPoint record tree; lengths, nesting and encryption are checked. */
function powerPointText(bytes) {
  const CFB = require('cfb');
  const compound = CFB.read(bytes, { type: 'buffer' });
  if (CFB.find(compound, 'EncryptedSummary')) throw new Error('Encrypted presentations cannot be previewed.');
  const entry = CFB.find(compound, 'PowerPoint Document');
  if (!entry?.content) throw new Error('The presentation could not be read.');
  const data = Buffer.from(entry.content);
  const text = [];
  function visit(start, end, depth) {
    if (depth > 64) throw new Error('The presentation is too complex to preview.');
    for (let at = start; at < end; ) {
      if (at + 8 > end) throw new Error('The presentation is damaged.');
      const version = data.readUInt16LE(at) & 15;
      const type = data.readUInt16LE(at + 2);
      const stop = at + 8 + data.readUInt32LE(at + 4);
      if (stop > end) throw new Error('The presentation is damaged.');
      if (version === 15) visit(at + 8, stop, depth + 1);
      else if (type === 4000) text.push(data.subarray(at + 8, stop).toString('utf16le'));
      else if (type === 4008) text.push(new TextDecoder('windows-1252').decode(data.subarray(at + 8, stop)));
      at = stop;
    }
  }
  visit(0, data.length, 0);
  const result = text.join('\n\n').replace(/\r/g, '\n');
  if (!result.trim()) throw new Error('No readable text was found in this presentation.');
  return result;
}

async function legacyOfficeText(bytes, ext) {
  if (ext === 'ppt') return powerPointText(bytes);
  const WordExtractor = require('word-extractor');
  const document = await new WordExtractor().extract(bytes);
  const text = document.getBody();
  if (!text.trim()) throw new Error('No readable text was found in this document.');
  return text;
}

module.exports = { legacyOfficeText, powerPointText };
