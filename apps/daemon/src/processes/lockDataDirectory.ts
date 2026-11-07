import { PRIVATE_DIRECTORY_MODE, PRIVATE_FILE_MODE } from "../database/LocalDatabase.ts";
import { processStartTime, wasStartedAt } from "./processStartTime.ts";
import { DateTime, Effect, FileSystem, Option, Schema } from "effect";
import { processExists } from "./stopProcessGroup.ts";
import { join } from "node:path";

export const LOCK_FILE_NAME = "dend.lock";

const LockFile = Schema.fromJsonString(Schema.Struct({ pid: Schema.Int, startedAt: Schema.Number }));

export class DataDirectoryInUseError extends Schema.TaggedError<DataDirectoryInUseError>()("DataDirectoryInUseError", {
	dataDir: Schema.String,
}) {
	override get message() {
		return `Another Den is already running on ${this.dataDir}. Quit it, then start Den again.`;
	}
}

// Holds the data directory for as long as the scope is open. A second daemon on the same directory
// would otherwise read the first one's live children from the registry as a crashed daemon's
// leftovers and stop them. The holder is recorded as pid plus start time, so a lock left by a daemon
// that died is replaced, and a reused pid is not mistaken for a running daemon.
export const lockDataDirectory = Effect.fn("lockDataDirectory")(function* (dataDir: string) {
	const fs = yield* FileSystem.FileSystem;
	const file = join(dataDir, LOCK_FILE_NAME);
	yield* fs.makeDirectory(dataDir, { recursive: true, mode: PRIVATE_DIRECTORY_MODE }).pipe(Effect.orDie);

	const ownStart = yield* processStartTime(process.pid);
	const contents = yield* Schema.encodeEffect(LockFile)({
		pid: process.pid,
		startedAt: Option.match(ownStart, { onNone: () => 0, onSome: DateTime.toEpochMillis }),
	}).pipe(Effect.orDie);
	// "wx" fails when the file exists, so only one daemon can create it.
	const create = fs.writeFileString(file, contents, { flag: "wx", mode: PRIVATE_FILE_MODE }).pipe(
		Effect.as(true),
		Effect.catchIf(
			(error) => error.reason._tag === "AlreadyExists",
			() => Effect.succeed(false),
		),
		Effect.orDie,
	);
	const holderIsRunning = fs.readFileString(file).pipe(
		Effect.flatMap(Schema.decodeUnknownEffect(LockFile)),
		Effect.option,
		Effect.flatMap(
			Option.match({
				// Unreadable: a daemon is writing it right now, or it is damaged. Either way, not ours to take.
				onNone: () => Effect.succeed(true),
				onSome: (holder) =>
					processExists(holder.pid).pipe(
						Effect.flatMap((alive) => (alive ? wasStartedAt(holder.pid, holder.startedAt) : Effect.succeed(false))),
					),
			}),
		),
	);

	if (!(yield* create)) {
		if (yield* holderIsRunning) {
			return yield* new DataDirectoryInUseError({ dataDir });
		}
		yield* Effect.logWarning("Replacing the lock of a daemon that is gone").pipe(Effect.annotateLogs({ dataDir }));
		yield* fs.remove(file, { force: true }).pipe(Effect.orDie);
		// Another daemon replacing the same stale lock got there first.
		if (!(yield* create)) {
			return yield* new DataDirectoryInUseError({ dataDir });
		}
	}
	yield* Effect.addFinalizer(() =>
		fs
			.remove(file, { force: true })
			.pipe(Effect.catch((cause) => Effect.logWarning("Could not remove the data directory lock", cause))),
	);
});
