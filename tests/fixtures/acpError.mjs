// Both ACP fakes preserve native JSON-RPC error codes, messages and optional structured details.
export class RpcError extends Error {
  constructor(code, message, data) {
    super(message);
    this.code = code;
    this.data = data;
  }
}

export function errorReply(id, error, fallbackCode = -32603) {
  return { id, error: { code: error?.code ?? fallbackCode, message: error?.message ?? String(error), data: error?.data } };
}
