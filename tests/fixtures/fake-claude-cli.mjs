// A stand-in for the Claude Code CLI process the SDK would start: it stays until it is killed, as a stuck CLI does (its stdin closing does not end it).
setInterval(() => undefined, 1_000_000);
