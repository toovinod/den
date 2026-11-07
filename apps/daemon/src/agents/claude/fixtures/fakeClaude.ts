#!/usr/bin/env bun
// Stands in for `claude auth status --json` in tests.
const out = Bun.stdout.writer();
out.write(
	`${JSON.stringify({ loggedIn: true, authMethod: "claude.ai", email: "dev@example.com" })}\n`,
);
out.flush();
