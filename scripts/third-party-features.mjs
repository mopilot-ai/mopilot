// Feature-owned notice metadata is discovered by folder, avoiding a shared dependency/notice registry.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const DIRECTORY = fileURLToPath(new URL('./third-party/', import.meta.url));

export function thirdPartyFeatures(directory = DIRECTORY) {
  return fs
    .readdirSync(directory)
    .filter((name) => name.endsWith('.json'))
    .sort()
    .map((name) => JSON.parse(fs.readFileSync(path.join(directory, name), 'utf8')));
}

export function featureNoticeTexts(root, notices) {
  return notices.map((notice) => {
    const text = fs
      .readFileSync(path.join(root, notice.path), 'utf8')
      .replace(/\r\n/g, '\n')
      .replace(/[ \t]+$/gm, '')
      .trimEnd();
    return `#### ${notice.title}\n\n\`\`\`text\n${text}\n\`\`\`\n`;
  });
}
