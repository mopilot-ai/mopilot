// Counters and gauges in the Prometheus text format. The relay counts events (frames, errors, closes, refusals, pushes) here
// and reads the rest (connections, mailbox depth, memory, event-loop lag) when it is scraped. Labels are codes and kinds, never
// ids, tokens or anything a client sent as content.

const escape = (/** @type {string} */ v) => v.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
const labelText = (/** @type {Record<string, string | number>} */ labels) => {
  const keys = Object.keys(labels).sort();
  return keys.length ? `{${keys.map((k) => `${k}="${escape(String(labels[k]))}"`).join(',')}}` : '';
};

export class Metrics {
  constructor() {
    /** @type {Map<string, { type: 'counter' | 'gauge', help: string, values: Map<string, number> }>} */
    this.series = new Map();
  }

  #get(/** @type {string} */ name, /** @type {'counter' | 'gauge'} */ type, /** @type {string} */ help) {
    let s = this.series.get(name);
    if (!s) this.series.set(name, (s = { type, help, values: new Map() }));
    return s;
  }

  /** Adds to a counter. */
  inc(/** @type {string} */ name, /** @type {Record<string, string | number>} */ labels = {}, n = 1, help = name) {
    const s = this.#get(name, 'counter', help);
    const key = labelText(labels);
    s.values.set(key, (s.values.get(key) ?? 0) + n);
  }

  /** Sets a gauge to a value (replacing any earlier value with the same labels). */
  set(/** @type {string} */ name, /** @type {number} */ value, /** @type {Record<string, string | number>} */ labels = {}, help = name) {
    this.#get(name, 'gauge', help).values.set(labelText(labels), value);
  }

  /** The text a scrape returns. */
  render() {
    const lines = [];
    for (const [name, s] of [...this.series].sort(([a], [b]) => (a < b ? -1 : 1))) {
      lines.push(`# HELP ${name} ${s.help}`, `# TYPE ${name} ${s.type}`);
      for (const [labels, value] of s.values) lines.push(`${name}${labels} ${Number.isFinite(value) ? value : 0}`);
    }
    return `${lines.join('\n')}\n`;
  }
}
