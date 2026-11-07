// Entry point for the Better Auth CLI (`bun run generate:schema`). The CLI only reads the
// plugin list to generate tables, so no real secrets or database are needed here.

import { authRelations } from "@repo/db-cloud/authSchema";
import { drizzle } from "drizzle-orm/bun-sql/postgres";
import { Redacted } from "effect";
import { createAuth } from "./createAuth.ts";

const placeholder = Redacted.make("schema-generation-only");
const oauthClient = {
	clientId: "schema-generation-only",
	clientSecret: placeholder,
};

export const auth = createAuth({
	config: {
		baseUrl: "http://localhost",
		webOrigin: "http://localhost",
		secret: placeholder,
		databaseUrl: placeholder,
		github: oauthClient,
		google: oauthClient,
	},
	database: drizzle.mock({ relations: authRelations }),
	sendInvitation: () => Promise.resolve(),
	publishMembershipEvent: () => Promise.resolve(),
});
