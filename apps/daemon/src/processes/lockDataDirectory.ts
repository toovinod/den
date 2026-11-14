import { PRIVATE_DIRECTORY_MODE } from "../database/LocalDatabase.ts";
import { Effect, FileSystem, Predicate, Schema } from "effect";
import { Database } from "bun:sqlite";
import { join } from "node:path";

export const LOCK_FILE_NAME = "octopusd.lock";

export class DataDirectoryInUseError extends Schema.TaggedError<DataDirectoryInUseError>()("DataDirectoryInUseError", {
	dataDir: Schema.String,
}) {
	override get message() {
		return `Another Octopus is already running on ${this.dataDir}. Quit it, then start Octopus again.`;
	}
}

const isBusy = (error: unknown) => Predicate.hasProperty(error, "code") && error.code === "SQLITE_BUSY";

// Holds the data directory for as long as the scope is open. A second daemon on the same directory
// would otherwise read the first one's live children from the registry as a crashed daemon's
// leftovers and stop them. The lock is an exclusive SQLite transaction, so the OS holds it and drops
// it when the process dies, however it dies: there is never a stale lock to judge or replace.
export const lockDataDirectory = Effect.fn("lockDataDirectory")(function* (dataDir: string) {
	const fs = yield* FileSystem.FileSystem;
	yield* fs.makeDirectory(dataDir, { recursive: true, mode: PRIVATE_DIRECTORY_MODE }).pipe(Effect.orDie);

	const db = yield* Effect.acquireRelease(
		Effect.sync(() => new Database(join(dataDir, LOCK_FILE_NAME), { create: true })),
		(db) => Effect.sync(() => db.close()),
	);
	yield* Effect.try({
		try: () => {
			// Fail at once rather than wait for the holder, which may run for days.
			db.run("PRAGMA busy_timeout = 0");
			// Keeps the lock after the transaction too, so it lasts until the connection closes.
			db.run("PRAGMA locking_mode = EXCLUSIVE");
			db.run("BEGIN EXCLUSIVE");
		},
		catch: (cause) => cause,
	}).pipe(
		// The driver throws untyped errors; only a busy lock is an expected outcome.
		Effect.catch((cause) =>
			isBusy(cause) ? Effect.fail(new DataDirectoryInUseError({ dataDir })) : Effect.die(cause),
		),
	);
});
