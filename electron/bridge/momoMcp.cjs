// window.native.momoMcp: the coding-side MCP servers' rows in Settings › MoMo › Sources (#2999 C0): every server coding chats configure, Allow (the tools it lists then get their defaults), Remove and one tool on or off (electron/momo/mcp/ipc.cjs, which refuses every call but Remove while MoMo is not allowed).
const { invoke, on } = require('./spec.cjs');

module.exports = {
  list: invoke('momoMcp:list'),
  allow: invoke('momoMcp:allow', 1),
  remove: invoke('momoMcp:remove', 1),
  setTool: invoke('momoMcp:setTool', 3),
  /** a server was allowed, removed, started or changed its tools: read the list again */
  onChanged: on('momoMcp:changed'),
};
