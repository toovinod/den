import { join } from "node:path";
import { BunRuntime } from "@effect/platform-bun";
import { PgClient } from "@effect/sql-pg";
import * as PgDrizzle from "drizzle-orm/effect-postgres";
import { migrate } from "drizzle-orm/effect-postgres/migrator";
import { Config, Effect } from "effect";
import { relations } from "./schema.ts";

const MIGRATIONS_FOLDER = join(import.meta.dir, "..", "drizzle");

export const migrateCloudDatabase = Effect.gen(function* () {
	const db = yield* PgDrizzle.makeWithDefaults({ relations });
	yield* migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
	yield* Effect.log("Cloud database is up to date");
}).pipe(
	Effect.provide(
		PgClient.layerConfig({ url: Config.Redacted("DATABASE_URL") }),
	),
);

if (import.meta.main) {
	BunRuntime.runMain(migrateCloudDatabase);
}
