// Regenerates the phone app's images from the desktop icon: `node scripts/make-icons.mjs <source.png> <outDir> [storeGraphicsDir]`, run as `npm run icons`.
import { writeIcons, writeStoreGraphics } from './icons.mjs';

const [source, out, graphics] = process.argv.slice(2);
console.log(writeIcons(source, out).join('\n'));
if (graphics) console.log(writeStoreGraphics(source, graphics).join('\n'));
