// The tool-relay requests of the Host wire: a harness that runs on the Host calls MoPilot's tools through the Host's tool socket, and the Host hands each call to the paired app, which runs it (approvals, site permission and per-Host routing are the app's). Parsers only; schema.mjs mounts them so the app and the Host share them.

import { MAX_FRAME } from './frames.mjs';

/** The methods, for the feature gate (schema.mjs REQUIRES). */
export const TOOL_METHODS = Object.freeze(['host.toolsSync', 'host.toolResult']);

const TOOL_NAME = /^[a-zA-Z0-9_-]{1,64}$/;
const ID = /^[\w.:-]{1,200}$/;
const POLICIES = new Set(['observe', 'act', 'irreversible']);
const MAX_TOOLS = 256;
const MAX_DESCRIPTION = 8 * 1024;
const MAX_SCHEMA_CHARS = 64 * 1024;
const MAX_BLOCKS = 64;
/** What one result may carry in all: a frame less its envelope. A larger one would not arrive as a message. */
const MAX_RESULT = MAX_FRAME - 64 * 1024;
const MAX_CODE = 64;
const MAX_MESSAGE = 16 * 1024;

const isRecord = (/** @type {unknown} */ v) => !!v && typeof v === 'object' && !Array.isArray(v);

/**
 * @param {(p: any) => { chatId: string, epoch: number }} scoped the chat and epoch a request names
 * @param {(message: string) => Error} bad the schema's error for a request the client got wrong
 * @returns {Record<string, (p: any) => any>}
 */
export function toolParsers(scoped, bad) {
  const toolOf = (/** @type {any} */ t, /** @type {Set<string>} */ seen) => {
    if (!isRecord(t) || typeof t.name !== 'string' || !TOOL_NAME.test(t.name)) throw bad('That tool has no usable name.');
    if (seen.has(t.name)) throw bad(`The tool ${t.name} is listed twice.`);
    seen.add(t.name);
    if (!POLICIES.has(t.policy)) throw bad(`The tool ${t.name} has no policy.`);
    const description = t.description == null ? '' : t.description;
    if (typeof description !== 'string' || description.length > MAX_DESCRIPTION) throw bad(`The description of ${t.name} is not usable.`);
    const inputSchema = t.inputSchema == null ? { type: 'object', properties: {} } : t.inputSchema;
    if (!isRecord(inputSchema) || JSON.stringify(inputSchema).length > MAX_SCHEMA_CHARS) throw bad(`The input of ${t.name} is not usable.`);
    return { name: t.name, description, inputSchema, policy: t.policy };
  };
  const blockOf = (/** @type {any} */ b) => {
    if (isRecord(b) && b.type === 'text' && typeof b.text === 'string') return { type: 'text', text: b.text };
    if (
      isRecord(b) &&
      b.type === 'image' &&
      typeof b.data === 'string' &&
      typeof b.mimeType === 'string' &&
      /^image\/[\w.+-]{1,40}$/.test(b.mimeType)
    )
      return { type: 'image', data: b.data, mimeType: b.mimeType };
    throw bad('That tool result has a block this Host cannot pass on.');
  };
  return {
    'host.toolsSync': (p) => {
      if (!Array.isArray(p.tools) || p.tools.length > MAX_TOOLS) throw bad('Send the list of tools.');
      const seen = new Set();
      return { tools: p.tools.map((t) => toolOf(t, seen)) };
    },
    'host.toolResult': (p) => {
      if (typeof p.callId !== 'string' || !ID.test(p.callId)) throw bad('That tool call is not one this Host knows.');
      if (typeof p.ok !== 'boolean') throw bad('Say whether the tool call worked.');
      if (!Array.isArray(p.content) || p.content.length > MAX_BLOCKS) throw bad('That tool result has no usable content.');
      const content = p.content.map(blockOf);
      const size = content.reduce((n, b) => n + (b.type === 'text' ? b.text.length : b.data.length), 0);
      if (size > MAX_RESULT)
        throw bad('That tool result is larger than one message can carry. Ask for less (a smaller screenshot, a narrower read).');
      const result = { ...scoped(p), callId: p.callId, ok: p.ok, content };
      if (p.ok) return p.endsTurn === true ? { ...result, endsTurn: true } : result;
      const e = p.error;
      if (
        !isRecord(e) ||
        typeof e.code !== 'string' ||
        !e.code ||
        e.code.length > MAX_CODE ||
        typeof e.message !== 'string' ||
        e.message.length > MAX_MESSAGE
      )
        throw bad('A failed tool call needs its error.');
      return { ...result, error: { code: e.code, message: e.message } };
    },
  };
}
