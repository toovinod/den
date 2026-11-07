import { join } from "node:path";
import { SqliteClient } from "@effect/sql-sqlite-bun";
import type { EffectDrizzleQueryError } from "drizzle-orm/effect-core";
import * as SQLiteBunDrizzle from "drizzle-orm/effect-sqlite-bun";
import { migrate } from "drizzle-orm/sqlite-core/effect";
import { Context, Duration, Effect, FileSystem, Layer, Schema } from "effect";
import { SqlError } from "effect/sql/SqlError";
import { DaemonConfig } from "../config/DaemonConfig.ts";
import { embeddedMigrations } from "./embeddedMigrations.ts";

export type LocalDrizzle = SQLiteBunDrizzle.EffectSQLiteBunDatabase;

type DriverError = EffectDrizzleQueryError | SqlError;

const isRetryableDriverError = (error: DriverError) => {
	const sqlError = error instanceof SqlError ? error : error.cause;
	return sqlError instanceof SqlError && sqlError.isRetryable;
};

export class LocalDatabaseError extends Schema.TaggedError<LocalDatabaseError>()(
	"LocalDatabaseError",
	{
		// A busy or locked database is retryable. Everything else is permanent.
		retryable: Schema.Boolean,
		cause: Schema.Defect(),
	},
) {}

export const DATABASE_FILE_NAME = "swarm.db";

export class LocalDatabase extends Context.Service<
	LocalDatabase,
	{
		// Runs Drizzle queries (or a transaction) and maps driver failures to LocalDatabaseError.
		// Domain checks return values from `run` and fail outside it, so `run` only fails with driver errors.
		readonly query: <A>(
			run: (db: LocalDrizzle) => Effect.Effect<A, DriverError>,
		) => Effect.Effect<A, LocalDatabaseError>;
	}
>()("swarm/daemon/database/LocalDatabase") {
	static readonly layer = Layer.effect(
		LocalDatabase,
		Effect.gen(function* () {
			const db = yield* SQLiteBunDrizzle.makeWithDefaults();
			const client = yield* SqliteClient.SqliteClient;
			// The client keeps one connection, so this pragma holds for every query.
			yield* client`PRAGMA foreign_keys = ON`;
			yield* migrate(embeddedMigrations(), db._.session);

			return LocalDatabase.of({
				query: (run) =>
					run(db).pipe(
						Effect.mapError(
							(cause) =>
								new LocalDatabaseError({
									retryable: isRetryableDriverError(cause),
									cause,
								}),
						),
					),
			});
		}),
	).pipe(
		Layer.provide(
			Layer.unwrap(
				Effect.gen(function* () {
					const { dataDir } = yield* DaemonConfig;
					const fs = yield* FileSystem.FileSystem;
					yield* fs.makeDirectory(dataDir, { recursive: true });
					// SqliteClient turns on WAL by default.
					return SqliteClient.layer({
						filename: join(dataDir, DATABASE_FILE_NAME),
						busyTimeout: Duration.seconds(5),
					});
				}),
			),
		),
	);
}
