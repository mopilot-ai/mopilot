// Derives the phone app's launcher, adaptive, splash, notification and favicon images from the desktop icon (build/icon.png).
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { decodePng, encodePng } from './png.mjs';

/** Android keeps a 66dp circle of the 108dp adaptive layer visible under every launcher mask. */
const SAFE_RADIUS = 33 / 108;
const SUPERSAMPLE = 3;

/**
 * Every generated image. `kind`: opaque = glyph over the brand color with no alpha, glyph = the brand glyph on
 * transparency, white = a white glyph on transparency (Android tints these). `scale`: 'tile' sizes the glyph as the
 * desktop tile does (the OS draws the corners), a number multiplies the glyph's size on the desktop icon.
 */
export const ICONS = [
  { file: 'icon.png', size: 1024, kind: 'opaque', scale: 'tile' },
  { file: 'adaptive-foreground.png', size: 1024, kind: 'glyph', scale: 1.1, safe: true },
  { file: 'adaptive-monochrome.png', size: 1024, kind: 'white', scale: 1.1, safe: true },
  { file: 'splash-icon.png', size: 1024, kind: 'glyph', scale: 1 },
  { file: 'notification-icon.png', size: 96, kind: 'white', scale: 1.5 },
  { file: 'favicon.png', size: 48, kind: 'opaque', scale: 'tile' },
];

const hex = ([r, g, b]) => `#${[r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('')}`;

/**
 * Reads the desktop icon: the background and glyph colors, the tile width, and a 0..1 coverage mask of the glyph.
 * The glyph is the only orange part of the icon, so its coverage is how far red is above blue (gray tile, border and
 * transparent margin all have red equal to blue).
 */
export function readBrand(sourcePath) {
  const { width, height, data } = decodePng(readFileSync(sourcePath));
  const px = (x, y) => [data[(y * width + x) * 4], data[(y * width + x) * 4 + 1], data[(y * width + x) * 4 + 2]];
  let glyph = px(0, 0);
  for (let i = 0; i < width * height; i++) {
    if (data[i * 4] - data[i * 4 + 2] > glyph[0] - glyph[2]) glyph = [data[i * 4], data[i * 4 + 1], data[i * 4 + 2]];
  }
  const background = px(width >> 1, height >> 2);
  const span = glyph[0] - glyph[2];
  const mask = new Float32Array(width * height);
  let tileWidth = 0;
  let reach = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      mask[i] = Math.min(1, Math.max(0, (data[i * 4] - data[i * 4 + 2]) / span)) * (data[i * 4 + 3] / 255);
      if (mask[i] > 0.5) reach = Math.max(reach, Math.hypot(x + 0.5 - width / 2, y + 0.5 - height / 2));
    }
  }
  for (let x = 0; x < width; x++) if (data[((height >> 1) * width + x) * 4 + 3] > 127) tileWidth++;
  return { width, height, mask, glyph, background, tileWidth, reach, glyphHex: hex(glyph), backgroundHex: hex(background) };
}

function sample(brand, x, y) {
  const { width, height, mask } = brand;
  const fx = x - 0.5;
  const fy = y - 0.5;
  const x0 = Math.floor(fx);
  const y0 = Math.floor(fy);
  const tx = fx - x0;
  const ty = fy - y0;
  const at = (xx, yy) => (xx < 0 || yy < 0 || xx >= width || yy >= height ? 0 : mask[yy * width + xx]);
  return (at(x0, y0) * (1 - tx) + at(x0 + 1, y0) * tx) * (1 - ty) + (at(x0, y0 + 1) * (1 - tx) + at(x0 + 1, y0 + 1) * tx) * ty;
}

/** Renders one entry of ICONS to RGBA pixels; throws when a `safe` glyph would leave the Android safe circle. */
export function renderIcon(brand, { size, kind, scale, safe }) {
  const factor = scale === 'tile' ? brand.width / brand.tileWidth : scale;
  if (safe && (brand.reach * factor * size) / brand.width > SAFE_RADIUS * size) throw new Error('the glyph leaves the adaptive icon safe zone');
  const data = Buffer.alloc(size * size * 4);
  const perPixel = brand.width / size / factor;
  const centerX = brand.width / 2;
  const centerY = brand.height / 2;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let coverage = 0;
      for (let j = 0; j < SUPERSAMPLE; j++) {
        for (let i = 0; i < SUPERSAMPLE; i++) {
          const sx = centerX + (x + (i + 0.5) / SUPERSAMPLE - size / 2) * perPixel;
          const sy = centerY + (y + (j + 0.5) / SUPERSAMPLE - size / 2) * perPixel;
          coverage += sample(brand, sx, sy);
        }
      }
      coverage /= SUPERSAMPLE * SUPERSAMPLE;
      const o = (y * size + x) * 4;
      for (let c = 0; c < 3; c++) {
        if (kind === 'opaque') data[o + c] = Math.round(brand.background[c] + (brand.glyph[c] - brand.background[c]) * coverage);
        else data[o + c] = kind === 'white' ? 255 : brand.glyph[c];
      }
      data[o + 3] = kind === 'opaque' ? 255 : Math.round(coverage * 255);
    }
  }
  return { width: size, height: size, data };
}

/** Writes every icon under `outDir` and returns the file names. */
export function writeIcons(sourcePath, outDir) {
  const brand = readBrand(sourcePath);
  mkdirSync(outDir, { recursive: true });
  for (const spec of ICONS) writeFileSync(join(outDir, spec.file), encodePng(renderIcon(brand, spec), { alpha: spec.kind !== 'opaque' }));
  return ICONS.map((i) => i.file);
}

/** Images the stores ask for that the app build does not read: Google Play's 512 px icon and its 1024x500 feature graphic. */
export const STORE_GRAPHICS = [
  { file: 'play-store-icon.png', width: 512, height: 512 },
  { file: 'play-feature-graphic.png', width: 1024, height: 500 },
];

/** The feature graphic: the brand glyph centered on the brand color, full bleed and opaque. */
export function renderFeatureGraphic(brand, { width, height }) {
  const glyph = renderIcon(brand, { size: height, kind: 'glyph', scale: 1.1 });
  const data = Buffer.alloc(width * height * 4);
  const left = (width - height) >> 1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 4;
      const g = x >= left && x < left + height ? (y * height + (x - left)) * 4 : -1;
      const alpha = g < 0 ? 0 : glyph.data[g + 3] / 255;
      for (let c = 0; c < 3; c++) data[o + c] = Math.round(brand.background[c] + ((g < 0 ? 0 : glyph.data[g + c]) - brand.background[c]) * alpha);
      data[o + 3] = 255;
    }
  }
  return { width, height, data };
}

/** Writes the store images under `outDir` and returns the file names. */
export function writeStoreGraphics(sourcePath, outDir) {
  const brand = readBrand(sourcePath);
  mkdirSync(outDir, { recursive: true });
  for (const spec of STORE_GRAPHICS) {
    const image = spec.width === spec.height ? renderIcon(brand, { size: spec.width, kind: 'opaque', scale: 'tile' }) : renderFeatureGraphic(brand, spec);
    writeFileSync(join(outDir, spec.file), encodePng(image, { alpha: false }));
  }
  return STORE_GRAPHICS.map((g) => g.file);
}
