// node:assert and t.assert comparisons that report DOM nodes, DOM/React events and React fibers briefly, so a failing test cannot hang the machine.
//
// A failing assert formats both values with util.inspect at depth 1000 and customInspect off, and util.inspect only
// stops at cycles on the current path, so a happy-dom node (which reaches its window, document and React fibers
// through many paths) expands without bound: one `assert.equal(element, null)` reached tens of gigabytes within
// seconds. util.inspect.custom cannot help, because assert turns it off. Instead, each comparison whose operands hold
// such an object runs with an Error as its message, which assert throws without formatting anything, and the
// failure is reported with copies in which those objects are replaced by a one-line summary string.
import assert, { AssertionError } from 'node:assert';
import { syncBuiltinESMExports } from 'node:module';
import { assert as testAssert } from 'node:test';

/** The comparisons that take (actual, expected, message) and format both values when they fail. */
export const COMPARISONS = [
  'equal',
  'notEqual',
  'strictEqual',
  'notStrictEqual',
  'deepEqual',
  'notDeepEqual',
  'deepStrictEqual',
  'notDeepStrictEqual',
  'partialDeepStrictEqual',
] as const;

/** How many objects a check or a copy visits before it stops. */
export const VISIT_BUDGET = 5000;
const MAX_ITEMS = 50;

const clip = (text: string) => (text.length > 60 ? `${text.slice(0, 57)}...` : text);
const attribute = (name: string, value: string) => (value === '' ? name : `${name}="${clip(value)}"`);

function nodeSummary(node: any): string {
  if (node.nodeType === 1) {
    const attrs = Array.from(node.attributes ?? [], (a: any) => ` ${attribute(a.name, a.value)}`).slice(0, 6);
    return `<${String(node.tagName).toLowerCase()}${attrs.join('')}>`;
  }
  if (node.nodeType === 3 || node.nodeType === 8) return `${node.nodeName} ${JSON.stringify(clip(String(node.data)))}`;
  return String(node.nodeName);
}

const constructorName = (value: object) => {
  const name = (value as any).constructor?.name;
  return typeof name === 'string' && name ? name : undefined;
};

/** A one-line description of a DOM window, node, event or React fiber; undefined for anything else. */
export function domSummary(value: object): string | undefined {
  const v = value as any;
  try {
    if (v.window === v && v.document) return `Window(${v.location?.href ?? ''})`;
    if (typeof v.nodeType === 'number' && typeof v.nodeName === 'string') return nodeSummary(v);
    if (v.nativeEvent && typeof v.isPropagationStopped === 'function') return `SyntheticEvent(${v.type})`;
    if (typeof v.type === 'string' && typeof v.preventDefault === 'function' && 'bubbles' in v)
      return `${constructorName(v) ?? 'Event'}(${v.type})`;
    if (typeof v.tag === 'number' && 'stateNode' in v && 'return' in v && 'alternate' in v) {
      const type = v.type;
      return `FiberNode(${typeof type === 'string' ? type : (type?.displayName ?? type?.name ?? v.tag)})`;
    }
  } catch {
    return '[unreadable object]';
  }
  return undefined;
}

/** Values that hold nothing but bytes, a time or a pattern: neither a check nor a copy looks inside them. */
const opaque = (value: object) =>
  ArrayBuffer.isView(value) || value instanceof ArrayBuffer || value instanceof Date || value instanceof RegExp;

/** Add the objects a value holds in its elements, own enumerable data properties, Map entries and Set members. */
function pushChildren(value: object, stack: unknown[]) {
  const add = (child: unknown) => {
    if (child !== null && typeof child === 'object') stack.push(child);
  };
  if (opaque(value)) return;
  if (value instanceof Map) {
    for (const [key, entry] of value) {
      add(key);
      add(entry);
    }
    return;
  }
  if (value instanceof Set) {
    for (const entry of value) add(entry);
    return;
  }
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) add(value[i]);
    return;
  }
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Reflect.getOwnPropertyDescriptor(value, key);
    if (descriptor?.enumerable && 'value' in descriptor) add(descriptor.value);
  }
}

/**
 * Whether the value holds a DOM object among its first `budget` objects. A larger value without one keeps node:assert's
 * own report; the RSS watchdog stops it should that run away.
 */
export function holdsDom(value: unknown, budget = VISIT_BUDGET): boolean {
  const seen = new Set<object>();
  const stack = [value];
  while (stack.length && seen.size < budget) {
    const item = stack.pop() as object;
    if (item === null || typeof item !== 'object' || seen.has(item)) continue;
    seen.add(item);
    try {
      if (domSummary(item) !== undefined) return true;
      pushChildren(item, stack);
    } catch {
      return true;
    }
  }
  return false;
}

const shells = new Map<string, new () => object>();
/** An empty object that inspects with the original's class name, without running the original class's code. */
function shellOf(value: object): object {
  const proto = Object.getPrototypeOf(value);
  if (proto === null || proto === Object.prototype) return Object.create(proto);
  const name = constructorName(value) ?? 'Object';
  let shell = shells.get(name);
  if (!shell) {
    shell = { [name]: class {} }[name];
    shells.set(name, shell);
  }
  return new shell();
}

/** A copy of the value for a failure report: DOM objects become their summary string, and it stops after the budget. */
export function briefCopy(value: unknown, budget = VISIT_BUDGET): unknown {
  const copies = new Map<object, unknown>();
  const copy = (item: unknown): unknown => {
    if (item === null || typeof item !== 'object') return item;
    if (copies.has(item)) return copies.get(item);
    if (copies.size >= budget) return '[...]';
    const summary = domSummary(item);
    if (summary !== undefined) {
      copies.set(item, summary);
      return summary;
    }
    if (opaque(item)) return item;
    if (Array.isArray(item)) {
      const out: unknown[] = [];
      copies.set(item, out);
      for (const element of item.slice(0, MAX_ITEMS)) out.push(copy(element));
      if (item.length > MAX_ITEMS) out.push(`... ${item.length - MAX_ITEMS} more items`);
      return out;
    }
    if (item instanceof Map) {
      const out = new Map();
      copies.set(item, out);
      for (const [key, entry] of [...item].slice(0, MAX_ITEMS)) out.set(copy(key), copy(entry));
      if (item.size > MAX_ITEMS) out.set('...', `${item.size - MAX_ITEMS} more entries`);
      return out;
    }
    if (item instanceof Set) {
      const out = new Set();
      copies.set(item, out);
      for (const entry of [...item].slice(0, MAX_ITEMS)) out.add(copy(entry));
      if (item.size > MAX_ITEMS) out.add(`... ${item.size - MAX_ITEMS} more entries`);
      return out;
    }
    let keys: (string | symbol)[];
    try {
      keys = Reflect.ownKeys(item);
    } catch {
      return '[unreadable object]';
    }
    const out: any = shellOf(item);
    copies.set(item, out);
    // an error's message is not enumerable, and node:assert would have shown it
    if (item instanceof Error) out.message = item.message;
    for (const key of keys.slice(0, MAX_ITEMS)) {
      const descriptor = Reflect.getOwnPropertyDescriptor(item, key);
      if (descriptor?.enumerable) out[key] = 'value' in descriptor ? copy(descriptor.value) : '[Getter]';
    }
    if (keys.length > MAX_ITEMS) out['...'] = `${keys.length - MAX_ITEMS} more properties`;
    return out;
  };
  return copy(value);
}

class ComparisonFailed extends Error {}

/** The operator node:assert reports for each comparison. */
const OPERATORS: Record<string, string> = { equal: '==', notEqual: '!=' };

/** A comparison that behaves as `original`, but reports operands holding DOM objects as brief copies. */
export function briefComparison(original: (...args: any[]) => void) {
  const name = original.name;
  const wrapper = {
    [name](...args: unknown[]) {
      const [actual, expected, message] = args as [unknown, unknown, string | Error | undefined];
      // a missing argument and an Error message format nothing: node:assert handles them as usual
      if (args.length < 2 || message instanceof Error || !(holdsDom(actual) || holdsDom(expected))) return original(...args);
      const failed = new ComparisonFailed();
      try {
        return original(actual, expected, failed);
      } catch (error) {
        if (error !== failed) throw error;
      }
      // node:assert formats the copies the way it would have formatted the values
      throw new AssertionError({
        message,
        actual: briefCopy(actual),
        expected: briefCopy(expected),
        operator: OPERATORS[name] ?? name,
        stackStartFn: wrapper,
      });
    },
  }[name];
  return wrapper;
}

/**
 * Replace the comparisons of node:assert and node:assert/strict, for default and named imports alike, and those of
 * node:test's `t.assert` (its loose node:assert ones).
 */
export function installBriefAssert(
  target: Record<string, any> = assert,
  register: (name: string, fn: (...args: any[]) => void) => void = testAssert.register,
) {
  for (const object of [target, target.strict]) {
    for (const name of COMPARISONS) {
      const original = object[name];
      if (typeof original === 'function' && !original.brief) object[name] = Object.assign(briefComparison(original), { brief: true });
    }
  }
  syncBuiltinESMExports();
  for (const name of COMPARISONS) if (target[name]?.brief) register(name, target[name]);
}
