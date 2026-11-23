// Generates MoPilot's working mark (src/components/thread/workingMark/markSheets.ts): a four-ray spark drawn in SVG strips.
import { existsSync, realpathSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const OUTPUT = 'src/components/thread/workingMark/markSheets.ts';
/** One frame's side in SVG units; the view scales a strip to MARK_SIZE per frame. */
const SIZE = 48;
const CENTER = SIZE / 2;
const SPEED = 33.3333;
/** Matches the startup dot's --brand-claude tint in src/styles/tokens.css. */
const CLAY = '#d97757';
const AMBER = '#e2b341';
const RAY_ANGLES = [-90, 0, 90, 180];
const RAY_START = 9.5;
const RAY_LENGTH = 7.5;
const RAY_WIDTH = 4.5;
const CORE_RADIUS = 3.75;
/** Half the CSS fallback dot's diameter (35% of a frame). */
const START_RADIUS = SIZE * 0.175;

const ease = (t) => (t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2);
const wave = (t) => (1 - Math.cos(2 * Math.PI * t)) / 2;
const mix = (a, b, t) => a + (b - a) * t;
const hex = (from, to, t) => {
  const channel = (c, i) => parseInt(c.slice(1 + i * 2, 3 + i * 2), 16);
  return `#${[0, 1, 2]
    .map((i) =>
      Math.round(mix(channel(from, i), channel(to, i), t))
        .toString(16)
        .padStart(2, '0'),
    )
    .join('')}`;
};

/**
 * A spark frame. `reach` extends individual rays and `lift` raises them independently of the core.
 * @param {{ turn?: number, scale?: number, color?: string, opacity?: number, slide?: number, reach?: number[], lift?: number[] }} [options]
 */
const pose = ({ turn = 0, scale = 1, color = CLAY, opacity = 1, slide = 0, reach = [], lift = [] } = {}) => {
  const x = CENTER + slide;
  return {
    color,
    opacity,
    x,
    radius: CORE_RADIUS * scale,
    width: RAY_WIDTH * scale,
    ring: null,
    rays: RAY_ANGLES.map((angle, i) => {
      const radians = ((angle + turn) * Math.PI) / 180;
      const cos = Math.cos(radians);
      const sin = Math.sin(radians);
      const start = RAY_START * scale;
      const length = (RAY_LENGTH + (reach[i] ?? 0)) * scale;
      return { x: x + start * cos, y: CENTER + start * sin - (lift[i] ?? 0), dx: length * cos, dy: length * sin };
    }),
  };
};

const grow = (t) => {
  const growth = ease(t);
  return { ...pose({ scale: growth }), radius: mix(START_RADIUS, CORE_RADIUS, growth) };
};

/** Each loop starts and ends on the resting pose, so a seam or rest frame on a cycle boundary is a clean cut. */
const LOOPS = {
  // the rays pulse in sequence
  default: {
    frames: 40,
    rest: 38,
    frame: (t) => pose({ reach: RAY_ANGLES.map((_, i) => 1.6 * wave(t - i / RAY_ANGLES.length)) }),
  },
  // a full orbit per cycle
  think: { frames: 110, seams: [54], rest: 95, cycles: 2, frame: (t) => pose({ turn: 360 * ease(t) }) },
  // the spark sweeps left and right, like eyes along a line
  read: { frames: 60, rest: 44, frame: (t) => pose({ slide: 4 * Math.sin(2 * Math.PI * t) }) },
  // a ring goes out from the center
  search: {
    frames: 20,
    rest: 4,
    frame: (t) => ({ ...pose({ scale: 1 - 0.15 * wave(t) }), ring: { r: mix(4, 22, t), opacity: 1 - t } }),
  },
  // the rays hop in sequence, like keys
  write: {
    frames: 60,
    rest: 36,
    frame: (t) => pose({ lift: RAY_ANGLES.map((_, i) => 3 * Math.max(0, Math.sin(2 * Math.PI * (t - i / RAY_ANGLES.length)))) }),
  },
  // a quarter turn per cycle, snapping into place
  code: { frames: 75, seams: [18, 37, 56], rest: 74, cycles: 4, frame: (t) => pose({ turn: 90 * ease(Math.min(1, t * 1.6)) }) },
  // amber, slowly dimming and back
  blocked: { frames: 30, rest: 0, frame: (t) => pose({ color: AMBER, opacity: 1 - 0.45 * wave(t) }) },
};

/** How many frames an activity's entry and exit take. */
const EDGES = {
  default: [16, 14],
  think: [16, 15],
  read: [21, 19],
  search: [16, 14],
  write: [31, 14],
  code: [16, 9],
  blocked: [16, 16],
};

const point = (x, y) => `${x.toFixed(2)} ${y.toFixed(2)}`;

const svg = (frames, draw) => {
  const body = [];
  for (let f = 0; f < frames; f++) {
    const { x, radius, width, rays, color, opacity, ring } = draw(f / Math.max(1, frames - 1), f);
    const y = f * SIZE;
    if (ring)
      body.push(
        `<circle cx="${CENTER}" cy="${y + CENTER}" r="${ring.r.toFixed(2)}" fill="none" stroke="${color}" stroke-width="2" opacity="${ring.opacity.toFixed(3)}"/>`,
      );
    const rayPath = rays.map((ray) => `M${point(ray.x, y + ray.y)}l${point(ray.dx, ray.dy)}`).join('');
    body.push(
      `<g opacity="${opacity.toFixed(3)}"><circle cx="${x.toFixed(2)}" cy="${y + CENTER}" r="${radius.toFixed(2)}" fill="${color}"/>`,
      `<path d="${rayPath}" fill="none" stroke="${color}" stroke-width="${width.toFixed(2)}" stroke-linecap="round"/></g>`,
    );
  }
  const text = `<svg xmlns="http://www.w3.org/2000/svg" width="${SIZE}" height="${SIZE * frames}" viewBox="0 0 ${SIZE} ${SIZE * frames}">${body.join('')}</svg>`;
  return `data:image/svg+xml;base64,${Buffer.from(text).toString('base64')}`;
};

/** Every sheet the stage machine plays: `grow`, then each activity's in, loop and out. */
export function markSheets() {
  const sheets = { grow: { frames: 10, speed: SPEED, url: svg(10, grow) } };
  for (const [name, loop] of Object.entries(LOOPS)) {
    const [inFrames, outFrames] = EDGES[name];
    const start = loop.frame(0);
    const weight = (t, from, to) => {
      const scale = mix(from, to, ease(t));
      return { ...start, radius: start.radius * scale, width: start.width * scale };
    };
    const color = (t, from, to) => (name === 'blocked' ? { color: hex(from, to, ease(t)) } : {});
    const cycles = loop.cycles || 1;
    const cycle = loop.frames / cycles;
    sheets[`${name}.in`] = {
      frames: inFrames,
      speed: SPEED,
      url: svg(inFrames, (t) => ({ ...weight(t, 0.6, 1), ...color(t, CLAY, AMBER) })),
    };
    sheets[`${name}.loop`] = {
      frames: loop.frames,
      speed: SPEED,
      ...(loop.seams ? { seams: loop.seams } : {}),
      rest: loop.rest,
      url: svg(loop.frames, (_, f) => loop.frame(((f % cycle) + 1e-9) / cycle)),
    };
    sheets[`${name}.out`] = {
      frames: outFrames,
      speed: SPEED,
      url: svg(outFrames, (t) => ({ ...weight(t, 1, 0.6), ...color(t, AMBER, CLAY) })),
    };
  }
  return sheets;
}

/** The generated module's source. */
export function source() {
  const entries = Object.entries(markSheets())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, { frames, speed, seams, rest, url }]) =>
      [
        `  ${/^[a-z]+$/.test(key) ? key : `'${key}'`}: {`,
        `    frames: ${frames},`,
        `    speed: ${speed},`,
        ...(seams ? [`    seams: [${seams.join(', ')}],`] : []),
        ...(rest === undefined ? [] : [`    rest: ${rest},`]),
        `    url: '${url}',`,
        '  },',
      ].join('\n'),
    );
  return `// MoPilot's working mark: per-activity spark sprite strips, generated by scripts/gen-working-mark.mjs; do not
// edit by hand. Each strip is a vertical run of square frames.

/** One sheet: its frames at \`speed\` ms each, the loop frames it may leave at, and the frame it rests on with reduced motion. */
export interface MarkSheet {
  frames: number;
  speed: number;
  seams?: readonly number[];
  rest?: number;
  /** the strip, one frame under another, as a data URL */
  url: string;
}

export const MARK_SHEETS: Record<string, MarkSheet> = {
${entries.join('\n')}
};
`;
}

/** Write the sheets to the selected file; a failed write must reach the caller.
 * @param {string | undefined} output @param {(file: string, text: string) => void} [write]
 */
export function generate(output, write = writeFileSync) {
  const destination = output || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', OUTPUT);
  write(destination, source());
}

if (process.argv[1] && existsSync(process.argv[1]) && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url))
  generate(process.argv[2]);
