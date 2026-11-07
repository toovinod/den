import { Context, Duration, Effect, FileSystem, Layer, Schema } from "effect";
import type { EffectDrizzleQueryError } from "drizzle-orm/effect-core";
import * as SQLiteBunDrizzle from "drizzle-orm/effect-sqlite-bun";
import { embeddedMigrations } from "./embeddedMigrations.ts";
import { DaemonConfig } from "../config/DaemonConfig.ts";
import { migrate } from "drizzle-orm/sqlite-core/effect";
import { SqliteClient } from "@effect/sql-sqlite-bun";
import { SqlError } from "effect/sql/SqlError";
import { join } from "node:path";

export type LocalDrizzle = SQLiteBunDrizzle.EffectSQLiteBunDatabase;

type DriverError = EffectDrizzleQueryError | SqlError;

const isRetryableDriverError = (error: DriverError) => {
	const sqlError = error instanceof SqlError ? error : error.cause;
	return sqlError instanceof SqlError && sqlError.isRetryable;
};

export class LocalDatabaseError extends Schema.TaggedError<LocalDatabaseError>()("LocalDatabaseError", {
	// A busy or locked database is retryable. Everything else is permanent.
	retryable: Schema.Boolean,
	cause: Schema.Defect(),
}) {}

export const DATABASE_FILE_NAME = "swarm.db";

export const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;

// SQLite creates the -wal and -shm files with the process umask; only the owner may read them.
const restrictDatabaseFiles = Effect.gen(function* () {
	const { dataDir } = yield* DaemonConfig;
	const fs = yield* FileSystem.FileSystem;
	for (const suffix of ["", "-wal", "-shm"]) {
		const file = join(dataDir, `${DATABASE_FILE_NAME}${suffix}`);
		if (yield* fs.exists(file)) {
			yield* fs.chmod(file, PRIVATE_FILE_MODE);
		}
	}
});

export class LocalDatabase extends Context.Service<
	LocalDatabase,
	{
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
			yield* restrictDatabaseFiles;

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
					yield* fs.makeDirectory(dataDir, {
						recursive: true,
						mode: PRIVATE_DIRECTORY_MODE,
					});
					// mkdir leaves an existing folder's mode alone, so tighten it explicitly.
					yield* fs.chmod(dataDir, PRIVATE_DIRECTORY_MODE);
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
