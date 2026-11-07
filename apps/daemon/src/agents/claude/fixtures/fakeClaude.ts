#!/usr/bin/env bun
const out = Bun.stdout.writer();
out.write(
	`${JSON.stringify({ loggedIn: true, authMethod: "claude.ai", email: "dev@example.com" })}\n`,
);
out.flush();
