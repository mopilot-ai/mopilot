// What a chat request is told when it came before `host.hello` fixed what both ends speak (host/src/protocol.mjs).
/** A chat request that came before `host.hello` fixed what both ends speak. */
export class HelloRequiredError extends Error {
  constructor() {
    super('Say hello first: the host and the app have not agreed on a version yet.');
    this.name = 'HelloRequiredError';
    this.code = 'hello_required';
  }
}
