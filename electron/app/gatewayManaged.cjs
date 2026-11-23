// Claude Code's deny entries for the MCP servers main's gateway runs (#2999 C4), read by each Claude session's setup through main's late-bound `live.gateway`: none before the gateway opens. It requires nothing of the gateway, so what asks it never reaches the gateway's credentials (tests/gatewayCredentials.invariant.test.ts).

/** @param {any} live main's late-bound services (its `gateway` once opened) @returns {object[]} */
const gatewayDenials = (live) => live.gateway?.nativeDenials() ?? [];

module.exports = { gatewayDenials };
