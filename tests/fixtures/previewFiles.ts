// Synthetic local documents exercise real decoders and players without private files, cloud services or app logins.
import fs from 'node:fs';
import path from 'node:path';
import JSZip from 'jszip';
import * as xlsx from 'xlsx';
import CFB from 'cfb';

// Both Node UT and Playwright's CommonJS compiler run from the repository root.
const fixtureFile = (name: string) => path.resolve('tests/fixtures/preview', name);

function assemblePdf(objects: (string | Buffer)[]) {
  const blocks = [Buffer.from('%PDF-1.7\n')],
    offsets = [0];
  let length = blocks[0].length;
  objects.forEach((object, index) => {
    offsets.push(length);
    const block = Buffer.concat([Buffer.from(`${index + 1} 0 obj\n`), Buffer.from(object), Buffer.from('\nendobj\n')]);
    blocks.push(block);
    length += block.length;
  });
  blocks.push(
    Buffer.from(
      `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets
        .slice(1)
        .map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`)
        .join('')}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${length}\n%%EOF\n`,
    ),
  );
  return Buffer.concat(blocks);
}

function pdfBytes() {
  return assemblePdf([
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 400] /Resources << /Font << /F1 7 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 400] /Resources << /Font << /F1 7 0 R >> >> /Contents 6 0 R >>',
    ...['First PDF page', 'Second PDF page'].map((text) => {
      const stream = `BT /F1 20 Tf 20 300 Td (${text}) Tj ET`;
      return `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`;
    }),
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ]);
}

export async function writePreviewFiles(folder: string) {
  fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(path.join(folder, 'document.pdf'), pdfBytes());
  const cjk = 'BT /F1 20 Tf 20 100 Td <67714EAC> Tj ET';
  fs.writeFileSync(
    path.join(folder, 'cjk.pdf'),
    assemblePdf([
      '<< /Type /Catalog /Pages 2 0 R >>',
      '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
      '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Resources << /Font << /F1 4 0 R >> >> /Contents 6 0 R >>',
      '<< /Type /Font /Subtype /Type0 /BaseFont /HeiseiMin-W3 /Encoding /UniJIS-UTF16-H /DescendantFonts [5 0 R] >>',
      '<< /Type /Font /Subtype /CIDFontType0 /BaseFont /HeiseiMin-W3 /CIDSystemInfo << /Registry (Adobe) /Ordering (Japan1) /Supplement 5 >> >>',
      `<< /Length ${cjk.length} >>\nstream\n${cjk}\nendstream`,
    ]),
  );
  const image = fs.readFileSync(fixtureFile('green.jp2'));
  const paint = 'q 160 0 0 160 20 20 cm /Im0 Do Q';
  fs.writeFileSync(
    path.join(folder, 'jpeg2000.pdf'),
    assemblePdf([
      '<< /Type /Catalog /Pages 2 0 R >>',
      '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
      '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Resources << /XObject << /Im0 4 0 R >> >> /Contents 5 0 R >>',
      Buffer.concat([
        Buffer.from(
          `<< /Type /XObject /Subtype /Image /Width 16 /Height 16 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /JPXDecode /Length ${image.length} >>\nstream\n`,
        ),
        image,
        Buffer.from('\nendstream'),
      ]),
      `<< /Length ${paint.length} >>\nstream\n${paint}\nendstream`,
    ]),
  );
  fs.writeFileSync(path.join(folder, 'broken.pdf'), 'not a PDF');
  fs.writeFileSync(path.join(folder, 'table.csv'), 'Name,Value\r\n"Hello, world","<script>unsafe()</script>"\r\nLast,42');
  fs.writeFileSync(path.join(folder, 'table.tsv'), 'Name\tValue\nTabbed\t42');
  fs.writeFileSync(
    path.join(folder, 'page.html'),
    '<!doctype html><html><body><h1>Rendered local HTML</h1><button onclick="this.textContent=\'Clicked\'">Try interaction</button><script>document.body.dataset.bridge=typeof window.native;</script></body></html>',
  );
  const word = new JSZip();
  word.file(
    '[Content_Types].xml',
    '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
  );
  word.file(
    '_rels/.rels',
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
  );
  word.file(
    'word/document.xml',
    '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Rendered Word document</w:t></w:r></w:p><w:sectPr><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="720" w:right="720" w:bottom="720" w:left="720"/></w:sectPr></w:body></w:document>',
  );
  fs.writeFileSync(path.join(folder, 'document.docx'), await word.generateAsync({ type: 'nodebuffer' }));
  const pptx = await import('@office-kit/pptx');
  const presentation = pptx.createPresentation();
  const layout = pptx.getSlideLayouts(presentation)[2];
  for (const title of ['First preview slide', 'Second preview slide']) {
    const slide = pptx.addSlide(presentation, { layout });
    pptx.setSlideTitle(slide, title);
    pptx.setSlideBody(slide, 'Local presentation content');
  }
  fs.writeFileSync(path.join(folder, 'slides.pptx'), await pptx.savePresentation(presentation));
  const book = xlsx.utils.book_new();
  xlsx.utils.book_append_sheet(book, xlsx.utils.aoa_to_sheet([['First worksheet'], ['<script>cell()</script>', 42]]), 'First');
  xlsx.utils.book_append_sheet(book, xlsx.utils.aoa_to_sheet([['Second worksheet']]), 'Second');
  xlsx.utils.book_append_sheet(
    book,
    { '!ref': 'A2001:B2001', A2001: { t: 's', v: 'Offset worksheet' }, B2001: { t: 'n', v: 42 } },
    'Offset',
  );
  for (const [name, bookType] of [
    ['book.xlsx', 'xlsx'],
    ['book.xls', 'biff8'],
  ] as const)
    fs.writeFileSync(path.join(folder, name), xlsx.write(book, { type: 'buffer', bookType }));
  const wave = Buffer.alloc(44 + 16000);
  wave.write('RIFF', 0);
  wave.writeUInt32LE(wave.length - 8, 4);
  wave.write('WAVEfmt ', 8);
  wave.writeUInt32LE(16, 16);
  wave.writeUInt16LE(1, 20);
  wave.writeUInt16LE(1, 22);
  wave.writeUInt32LE(8000, 24);
  wave.writeUInt32LE(16000, 28);
  wave.writeUInt16LE(2, 32);
  wave.writeUInt16LE(16, 34);
  wave.write('data', 36);
  wave.writeUInt32LE(16000, 40);
  fs.writeFileSync(path.join(folder, 'audio.wav'), wave);
  const bitmap = Buffer.alloc(70);
  bitmap.write('BM');
  bitmap.writeUInt32LE(70, 2);
  bitmap.writeUInt32LE(54, 10);
  bitmap.writeUInt32LE(40, 14);
  bitmap.writeInt32LE(2, 18);
  bitmap.writeInt32LE(2, 22);
  bitmap.writeUInt16LE(1, 26);
  bitmap.writeUInt16LE(24, 28);
  bitmap.writeUInt32LE(16, 34);
  bitmap[55] = 255;
  bitmap[58] = 255;
  bitmap[63] = 255;
  bitmap[66] = 255;
  fs.writeFileSync(path.join(folder, 'image.bmp'), bitmap);
  const compound = CFB.utils.cfb_new();
  const chars = Buffer.from('Legacy PowerPoint content', 'utf16le');
  const header = Buffer.alloc(8);
  header.writeUInt16LE(4000, 2);
  header.writeUInt32LE(chars.length, 4);
  CFB.utils.cfb_add(compound, 'PowerPoint Document', Buffer.concat([header, chars]));
  fs.writeFileSync(path.join(folder, 'legacy.ppt'), CFB.write(compound, { type: 'buffer' }));
  for (const name of ['video.mp4', 'video.webm', 'image.avif', 'legacy-word.doc'])
    fs.copyFileSync(fixtureFile(name), path.join(folder, name));
}
