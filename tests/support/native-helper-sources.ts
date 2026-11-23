// Reads every Swift module in the computer-use target for guards that must survive file extraction.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { treeFiles } from '../../scripts/source-tree.mjs';

export function readComputerHelperSources(
  root = fileURLToPath(new URL('../../native/helper/Sources/ComputerUseHelper/', import.meta.url)),
) {
  return treeFiles(root, /\.swift$/)
    .sort()
    .map((file) => readFileSync(file, 'utf8'))
    .join('\n');
}
